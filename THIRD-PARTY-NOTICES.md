# 第三方许可声明（THIRD-PARTY NOTICES）

本项目包含或衍生自以下第三方作品，其许可与版权声明如下。

---

## 1. xuexitong-zidong-shuake-jiaoben

- 来源：https://github.com/aajddjkfkfke/xuexitong-zidong-shuake-jiaoben
- 版本：1.0.7
- 许可：MIT License
- 版权：Copyright (c) 2026 aajddjkfkfke

本项目对其的使用方式：

- `extension-xxt/engine.js` 由该项目的用户脚本经 `build-engine.js` 包装生成（前置 GM_* 兼容层），逻辑主体保留原样；
- 页面侧播放、字体 `cmap` 解码、DeepSeek 作答调用等实现源自该项目；
- 已在此基础上做了大量修改与增补（见根目录 `README.md` 的架构说明）。

MIT 许可全文：

```
MIT License

Copyright (c) 2026 aajddjkfkfke

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. 可选依赖：bytenode

- 来源：https://github.com/bytenode/bytenode
- 许可：MIT
- 仅在执行 `node pack-bytecode.js` 生成商业发布包时使用，**本仓库运行不依赖它**。

---

## 3. 运行期外部服务

| 服务 | 域名 | 用途 | 数据传输 |
|---|---|---|---|
| DeepSeek API | `api.deepseek.com` | 章节测验作答 | 仅题目与选项文本；API Key 由使用者自行提供 |
| 超星学习通 | `*.chaoxing.com` | 被操作的平台 | 使用者自己的登录会话 |

本仓库不包含以上任何服务的代码或数据。

---

## 4. 不含的内容

为避免误解，明确列出本仓库**不包含**：

- 任何账号、密码、Cookie、API Key；
- 任何人脸识别 / 人脸比对接口实现；
- 任何验证码识别模型或打码平台对接；
- 任何平台加密算法逆向代码；
- 任何个人照片或素材（示例背景图已从代码中移除）。
