import { appendFileSync } from "node:fs";
import { printBlue, printGreen, printMagenta, printRed, printYellow } from "./utils/colorOut.js";
import { hasSecretWriteToken, setRepoSecret } from "./utils/githubSecrets.js";
import { maskDisplayName, maskIdentifier, sanitizeForLog, summarizeResponse } from "./utils/safeLog.js";
import { readUserinfo } from "./utils/userinfo.js";
import { close_api, delay, send, startService, waitForApi } from "./utils/utils.js";

/**
 * 写入 Actions 步骤摘要，方便在运行页面直接看结果，不用翻日志。
 */
function writeSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, lines.join("\n") + "\n");
  } catch (e) {
    // 摘要写失败不影响签到主流程
    console.log(`[summary] 写入失败: ${e.message}`);
  }
}

async function main() {
  const today = new Date();
  // 服务器时间比国内慢8小时
  today.setTime(today.getTime() + 8 * 60 * 60 * 1000);
  const DD = String(today.getDate()).padStart(2, "0");
  const MM = String(today.getMonth() + 1).padStart(2, "0");
  const yyyy = today.getFullYear();
  const date = `${yyyy}-${MM}-${DD}`;

  // 读取账号信息
  // 关键：readUserinfo 内部会对「未配置」和「JSON 非法」给出明确提示，
  // 而不是像旧版那样抛一个没有上下文的 "未配置"。
  const userinfo = readUserinfo();
  if (!userinfo.length) {
    printRed("❌ 未读取到账号信息，签到无法进行。");
    printYellow("");
    printYellow("请按以下步骤配置（只需做一次）：");
    printYellow("  1. 打开仓库的 Actions 页面，运行二维码登录任务");
    printYellow("  2. 用酷狗音乐 APP 扫码登录");
    printYellow("  3. 把输出的 USERINFO 粘贴到 Settings → Secrets and variables → Actions");
    printYellow("     变量名：USERINFO，值形如：[{[0m\"userid\":\"123\",\"token\":\"abc\"}]");
    writeSummary([
      "## ❌ 签到未执行",
      "",
      "**原因：未配置 `USERINFO` secret**",
      "",
      "请运行「二维码登录」工作流，用酷狗音乐 APP 扫码后，",
      "把输出的 JSON 粘贴到 Settings → Secrets and variables → Actions 的 `USERINFO` 变量。",
    ]);
    throw new Error("未配置 USERINFO secret");
  }

  // 启动服务并等待就绪（避免冷启动竞态导致首个请求失败）
  const api = startService();
  try {
    await waitForApi();
  } catch (e) {
    close_api(api);
    throw e;
  }

  const errorMsg = {};
  const results = [];
  let needRefresh = false;

  try {
    for (const user of userinfo) {
      // 关键修复：单账号异常隔离。
      // 任一账号的请求/解析异常只记录该账号失败，
      // 不影响其余账号继续执行，也不影响后续 token 刷新与 secret 写回。
      try {
        let headers = { "cookie": "token=" + user.token + "; userid=" + user.userid };

        const userDetail = await send(`/user/detail?timestrap=${Date.now()}`, "GET", headers);
        if (userDetail?.data?.nickname == null) {
          const safeUserId = maskIdentifier(user.userid);
          printRed(`❌ token 过期或账号不存在, userid: ${safeUserId}`);
          errorMsg[safeUserId] = {
            msg: `token 过期或账号不存在, userid: ${safeUserId}`,
            data: summarizeResponse(userDetail),
          };
          results.push({ nickname: safeUserId, status: "失败", listen: "token失效", vip: "0/0", expiry: "未知" });
          continue;
        }

        const safeNickname = maskDisplayName(userDetail.data.nickname);
        printMagenta(`账号 ${safeNickname} 开始领取VIP...`);

        // 周日刷新 token
        if (today.getDay() === 0) {
          const refreshToken = await send(`/login/token?timestrap=${Date.now()}`, "POST", headers);
          if (refreshToken?.status == 1 && refreshToken?.data?.token !== user.token) {
            needRefresh = true;
            printYellow(`账号 ${safeNickname} 需要刷新token`);
            user.token = refreshToken.data.token;
            // 关键修复：必须用新 token 重建 headers，
            // 否则后续听歌/VIP 领取仍在用已失效的旧 token。
            headers = { "cookie": "token=" + user.token + "; userid=" + user.userid };
          }
        }

        // 听歌领取
        printYellow("开始听歌领取VIP...");
        const listen = await send(`/youth/listen/song?timestrap=${Date.now()}`, "GET", headers);
        let listenStatus;
        if (listen.status === 1) {
          printGreen("✅ 听歌领取成功");
          listenStatus = "成功";
        } else if (listen.error_code === 130012) {
          printGreen("✅ 今日已领取");
          listenStatus = "今日已领取";
        } else {
          errorMsg[`${safeNickname} listen`] = summarizeResponse(listen);
          printRed("❌ 听歌领取失败");
          listenStatus = "失败";
        }

        // 领取VIP（最多8次，每次间隔30秒）
        printYellow("开始领取VIP...");
        let claimCount = 0;
        let claimTotal = 0;
        for (let i = 1; i <= 8; i++) {
          const ad = await send(`/youth/vip?timestrap=${Date.now()}`, "GET", headers);
          claimTotal = i;
          if (ad.status === 1) {
            printGreen(`✅ 第${i}次领取成功`);
            claimCount++;
            if (i != 8) {
              await delay(30 * 1000);
            }
          } else if (ad.error_code === 30002 || ad.error_code === 30000) {
            // 30000/30002 均表示今日领取次数已用光，属正常业务结果，不算失败
            printGreen("✅ 今天次数已用光");
            break;
          } else {
            printRed(`❌ 第${i}次领取失败`);
            errorMsg[`${safeNickname} ad`] = summarizeResponse(ad);
            break;
          }
        }

        // 查询VIP到期时间
        let vipExpiry = "未知";
        const vipDetails = await send(`/user/vip/detail?timestrap=${Date.now()}`, "GET", headers);
        if (
          vipDetails.status === 1 &&
          Array.isArray(vipDetails.data?.busi_vip) &&
          vipDetails.data.busi_vip.length > 0
        ) {
          vipExpiry = vipDetails.data.busi_vip[0].vip_end_time;
          printBlue(`今天是：${date}`);
          printBlue(`VIP到期时间：${vipExpiry}\n`);
        } else {
          printRed("获取VIP到期时间失败");
          errorMsg[`${safeNickname} vip_details`] = summarizeResponse(vipDetails);
        }

        const ok = listenStatus !== "失败" && claimCount > 0;
        results.push({
          nickname: safeNickname,
          status: ok ? "成功" : "部分失败",
          listen: listenStatus,
          vip: `${claimCount}/${claimTotal}`,
          expiry: vipExpiry,
        });
      } catch (err) {
        const safeUserId = maskIdentifier(user.userid || "未知");
        printRed(`❌ 账号 ${safeUserId} 处理异常：${err && err.message ? err.message : String(err)}`);
        errorMsg[safeUserId] = { msg: "处理异常", error: err && err.message ? err.message : String(err) };
        results.push({ nickname: safeUserId, status: "失败", listen: "异常", vip: "0/0", expiry: "未知" });
        continue;
      }
    }
  } finally {
    close_api(api);
  }

  // 写回刷新后的 token
  // 关键修复：写回完整的 userinfo 数组。
  // 旧实现写的是 refreshUserinfo（仅周日参与刷新的账号），
  // 多账号场景下会把未刷新的账号直接丢掉，导致下次签到缺少账号。
  if (needRefresh) {
    if (hasSecretWriteToken()) {
      try {
        setRepoSecret("USERINFO", JSON.stringify(userinfo));
        printGreen("✅ secret <USERINFO> token刷新成功");
      } catch (error) {
        printRed("❌ token刷新失败（不影响本次签到结果）");
        console.dir(sanitizeForLog({ message: error.message }), { depth: null });
      }
    } else {
      printYellow("⚠️ token 已刷新但未配置 PAT，无法自动写回 secret");
      printYellow("   旧 token 仍有效（最长约两个月），暂时不影响签到");
    }
  }

  // 输出摘要
  const successCount = results.filter((r) => r.status === "成功").length;
  const hasError = Object.keys(errorMsg).length > 0;
  const summary = [
    `## ${hasError ? "⚠️" : "✅"} 酷狗概念VIP签到 · ${date}`,
    "",
    `| 账号 | 结果 | 听歌领取 | VIP领取 | VIP到期 |`,
    `| --- | --- | --- | --- | --- |`,
    ...results.map(
      (r) => `| ${r.nickname} | ${r.status} | ${r.listen} | ${r.vip} | ${r.expiry} |`
    ),
    "",
    `共 ${results.length} 个账号，成功 ${successCount} 个，失败 ${results.length - successCount} 个。`,
  ];
  writeSummary(summary);

  if (hasError) {
    printRed("\n异常信息如下:");
    console.dir(sanitizeForLog(errorMsg), { depth: null });
    throw new Error("领取异常");
  }

  printGreen("\n🎉 全部账号签到完成");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
