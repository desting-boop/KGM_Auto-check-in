import { appendFileSync } from "node:fs";
import { printBlue, printGreen, printMagenta, printRed, printYellow } from "./utils/colorOut.js";
import { close_api, delay, send, startService, waitForApi } from "./utils/utils.js";
import { readUserinfo, saveUserinfo, upsertUser } from "./utils/userinfo.js";

/**
 * 写入 Actions 步骤摘要：把二维码放到运行摘要页面，方便直接点开。
 */
function writeSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, lines.join("\n") + "\n");
  } catch (e) {
    // 摘要写失败不影响登录主流程
    console.log(`[summary] 写入失败: ${e.message}`);
  }
}

async function login() {
  const NUMBER = parseInt(process.env.NUMBER || "1", 10);
  const APPEND_USER = process.env.APPEND_USER || "否";
  const append = APPEND_USER === "是" || APPEND_USER === "true" || APPEND_USER === "1";

  // 读取已有账号（追加模式下保留其它账号）
  let userinfo = [];
  try {
    userinfo = readUserinfo();
  } catch (e) {
    printYellow(`读取已有 USERINFO 失败：${e.message}`);
    printYellow("本次将只写入新登录的账号");
  }

  const api = startService();
  try {
    await waitForApi();
  } catch (e) {
    close_api(api);
    throw e;
  }

  try {
    for (let i = 0; i < NUMBER; i++) {
      printMagenta(`\n========== 第 ${i + 1}/${NUMBER} 个账号 ==========`);

      // 生成二维码
      const keyRes = await send(`/login/qr/key?timestrap=${Date.now()}`, "GET", {});
      if (keyRes.status !== 1) {
        printRed("二维码生成失败：");
        console.dir(keyRes, { depth: null });
        throw new Error("二维码生成失败");
      }
      const qrcode = keyRes.data.qrcode;
      const imgBase64 = keyRes.data.qrcode_img;

      // 二维码图片（base64 PNG）直接写进步骤摘要，浏览器可直接看
      // 注意：酷狗接口返回的 qrcode_img 已自带 "data:image/png;base64," 前缀，
      // 这里需先剥掉再重新拼接，否则会出现前缀重复导致图片无法渲染。
      if (imgBase64) {
        const raw = imgBase64.startsWith("data:") ? imgBase64.split(",").pop() : imgBase64;
        writeSummary([
          `## 📱 第 ${i + 1}/${NUMBER} 个账号 · 扫码登录`,
          "",
          `<img src="data:image/png;base64,${raw}" width="320" alt="酷狗登录二维码">`,
          "",
          `> 请用 **酷狗音乐 APP** 扫描二维码并确认登录。二维码约 2 分钟内有效。`,
          "",
          `<details><summary>无法显示图片？点此展开文本形式</summary>`,
          ``,
          `链接：https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${qrcode}`,
          ``,
          `</details>`,
        ]);
      }

      printMagenta("请用「酷狗音乐 APP」扫描下方二维码并确认登录（有效期约 2 分钟）");
      printBlue(`如图片无法显示，可直接打开链接：`);
      printBlue(`https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${qrcode}`);

      // 轮询等待扫码
      let logged = false;
      for (let wait = 0; wait < 30; wait++) {
        const res = await send(`/login/qr/check?key=${qrcode}&timestrap=${Date.now()}`, "GET", {});
        const status = res?.data?.status;
        if (status === 4) {
          printGreen("✅ 登录成功！");
          upsertUser(userinfo, { userid: res.data.userid, token: res.data.token }, append);
          logged = true;
          break;
        } else if (status === 0) {
          printRed("二维码已过期，请重新运行本工作流");
          break;
        } else if (status === 2) {
          printYellow("已扫码，请在 APP 上点击确认登录...");
        }
        await delay(5000);
      }

      if (!logged) {
        printYellow("⏳ 等待超时或二维码过期，未获取到登录信息");
      }
    }
  } finally {
    close_api(api);
  }

  if (!userinfo.length) {
    printRed("\n❌ 未获取到任何账号信息");
    writeSummary(["## ❌ 扫码登录未完成", "", "未获取到账号信息，请重新运行并及时扫码。"]);
    throw new Error("未获取到账号信息");
  }

  // 保存到 secret（有 PAT 则自动写；否则输出字符串让用户手动粘贴）
  const { persisted, reason } = saveUserinfo(userinfo);

  if (persisted) {
    printGreen("\n🎉 登录完成，secret <USERINFO> 已更新，下次签到将自动运行");
    writeSummary([
      "## ✅ 扫码登录完成",
      "",
      "账号信息已写入 secret `USERINFO`，签到任务将自动使用。",
    ]);
  } else {
    printYellow(`\n⚠️ 登录成功，但未能自动写入 secret（${reason}）`);
    printYellow("请把上面输出的 JSON 手动粘贴到 Settings → Secrets and variables → Actions → USERINFO");
    writeSummary([
      "## ⚠️ 登录成功，需手动保存",
      "",
      `未能自动写入 secret（${reason}）。`,
      "请把日志中输出的 JSON 复制到 Settings → Secrets and variables → Actions 的 `USERINFO` 变量。",
    ]);
  }
}

login()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
