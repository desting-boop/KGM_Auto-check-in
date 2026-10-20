import { execFileSync } from "child_process";

/**
 * 是否具备写入 repository secret 的能力。
 *
 * 注意：GitHub 内置的 GITHUB_TOKEN **不支持 secrets: write**，
 * 因此这里只认用户自己提供的 PAT（classic 令牌，repo 权限）。
 */
function hasSecretWriteToken() {
  return Boolean(process.env.PAT || process.env.GH_TOKEN);
}

/**
 * 写入 repository secret。
 *
 * @param {string} name secret 名称
 * @param {string} value secret 值
 */
function setRepoSecret(name, value) {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.PAT;

  if (!repository) {
    throw new Error("GITHUB_REPOSITORY 未配置");
  }
  if (!token) {
    throw new Error("PAT/GH_TOKEN 未配置");
  }

  execFileSync("gh", ["secret", "set", name, "--repo", repository], {
    input: value,
    encoding: "utf8",
    env: {
      ...process.env,
      GH_TOKEN: token,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export { hasSecretWriteToken, setRepoSecret };
