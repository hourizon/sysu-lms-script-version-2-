# 中山大学 LMS 学习助手 LLM 答题版

特别感谢 [Infe1/sysu-lms-assistant](https://github.com/Infe1/sysu-lms-assistant) 的原始项目。
![alt text](image.png)
[![Version](https://img.shields.io/badge/version-2.4-blue.svg)](https://github.com/hourizon/sysu-lms-script-version-2-)
[![License](https://img.shields.io/badge/license-GPL--3.0-brightgreen.svg)](https://www.gnu.org/licenses/gpl-3.0.html)

这是一个为中山大学（SYSU）LMS 平台设计的用户脚本，旨在帮助学生自动化部分学习任务。

## 描述

- 全自动完成国安+心理秒刷（伪造进度上报）；
- 自动跳转到下一课；
- 国安多阶段测验自动调用 LLM 答题、提交并跳转；
- 遇讨论页自动跳过。

## 功能

*   **自动完成课程**: 自动处理课程，伪造学习进度。
*   **自动导航**: 完成一个小节后自动跳转到下一个。
*   **LLM 辅助答题**: 在测验中，利用大型语言模型（LLM）自动生成答案并提交。
*   **跳过讨论**: 自动跳过课程中的讨论页面。

## 安装

1.  首先，您需要在您的浏览器中安装一个用户脚本管理器。我们推荐使用 [Tampermonkey](https://www.tampermonkey.net/)。
2.  安装脚本管理器后，请执行以下操作：
    a. 在 Tampermonkey 的仪表盘中，点击“+”号来创建一个新脚本。
    b. 将本项目中的 `script.js` 文件的全部内容复制。
    c. 将代码粘贴到 Tampermonkey 的编辑器中，替换掉所有默认内容。
    d. 保存脚本（通常是 `Ctrl+S` 或点击菜单中的“文件” -> “保存”）。
3.  现在，打开中山大学 LMS 平台，脚本应该会自动运行。

## 配置

脚本包含一些可配置的选项，例如 LLM API 的设置，可以在脚本的头部进行修改。

```javascript
// ==================== LLM 配置 (OpenAI 兼容接口) ====================
const LLM_CONFIG = {
    base_url: _localStorage.getItem('lms_llm_base_url') || 'https://api.deepseek.com/',
    model: _localStorage.getItem('lms_llm_model') || 'deepseek-v4-flash',
    api_key: _localStorage.getItem('lms_llm_api_key') || '',
    max_tokens: 1024,
    temperature: 0.1,
};
```

## 作者

- **hourizon** ([GitHub](https://github.com/hourizon))

## 许可证

本项目根据 [GPL-3.0 License](https://www.gnu.org/licenses/gpl-3.0.html) 授权。
