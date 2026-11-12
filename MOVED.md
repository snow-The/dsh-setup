# 這個 repo 的 profile 編譯器已搬走（2026-11-12）

`profiles/web/plugins.intent.json`、`scripts/derive-profile.mjs`、`scripts/npm-view.mjs`
以及它們的變異自檢，已抽到新的 `source/repos/dsh-profile`（本地 git，尚未 push）。

## 為什麼

這個 repo 混了兩件事：**profile 編譯器**（意圖 → 產物，可 CI 驗證）與**機器側工作**
（部署、宿主体檢、審計、patch 復原）。編譯器值得一個小而穩的 repo；其餘留在這裡當歷史與工具。

## 警告：不要再用這裡的 intent 生成 live profile

這裡的 `profiles/web/plugins.intent.json` 仍停在 6666 世代（`@linxin666/*` 已於 2026-11-12 從 live 移除），
而且 `derivedOverridesFrom` 還指著 `@linxin666/dsh-web-all`。跑：

```
node scripts/derive-profile.mjs --write --out ~/.dsh/profiles/web
```

會把那些套件**裝回 live profile**，而且 `derive:check` 仍然綠（它只驗生成物 vs 意圖，不驗現實）。

## 這裡還留下什麼（都還有用）

- `setup.ps1` / `setup.sh`：一鍵部署
- `host-doctor.mjs`、`host-map.mjs`、`host-range.mjs`、`preflight-host.mjs`、`upgrade-host.mjs`：宿主側
- `boot-check.mjs`、`plugin-load-check.mjs`、`e2e-verify.mjs`：啟動驗證
- `audit-*.mjs`、`commit-integrity.mjs`、`patch-guard.mjs`：審計與守衛
- `profiles/web/cordis.patch.yml`：patch 層的歷史版本（新 repo 有同一份）
