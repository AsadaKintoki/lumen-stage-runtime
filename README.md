# Lumen Stage

酒馆助手导入文件：[`loader/Lumen-Stage-Auto-Update.json`](./loader/Lumen-Stage-Auto-Update.json)。

导入后，酒馆通过 `main` 分支自动获取最新运行时：优先从 jsDelivr 的不可变提交地址加载，失败时回退到同一提交的 GitHub raw 地址。酒馆按钮名称为「Lumen Stage」。

## 维护与更新

更新发布内容后，将本仓库的 `main` 分支更新到新版本；已导入的 loader 会在后续启动时自动检查并获取。运行时文件只由私有源码仓库的白名单导出脚本生成，不要手动编辑 `runtime/` 或 loader JSON。
