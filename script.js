// ==UserScript==
// @name         中山大学 LMS 学习助手 LLM 答题版
// @namespace    https://github.com/hourizon/sysu-lms-assistant
// @version      2.4
// @description  全自动完成国安+心理秒刷课（伪造进度上报）；自动跳转到下一课，国安多阶段测验自动调用 LLM 答题、提交并跳转；遇讨论页自动跳过；
// @author       hourizon
// @match        *://lms.sysu.edu.cn/*
// @homepage     https://github.com/hourizon/sysu-lms-assistant
// @supportURL   https://github.com/hourizon/sysu-lms-assistant/issues
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      *
// @license      GPL-3.0 License
// ==/UserScript==

(async function () {
    'use strict';

    const _localStorage = unsafeWindow.localStorage;
    const _sessionStorage = unsafeWindow.sessionStorage;
    const $ = unsafeWindow.$;

    // ==================== LLM 配置 (OpenAI 兼容接口) ====================
    const LLM_CONFIG = {
        base_url: _localStorage.getItem('lms_llm_base_url') || 'https://api.deepseek.com/',
        model: _localStorage.getItem('lms_llm_model') || 'deepseek-v4-flash',
        api_key: _localStorage.getItem('lms_llm_api_key') || '',
        max_tokens: 1024,
        temperature: 0.1,
    };

    // ==================== 行为配置 ====================
    const CHECK_INTERVAL = 1000;
    const DELAY_BEFORE_NEXT = 1500;
    const SKIP_FORUM_DELAY = 2000;
    const VIDEO_END_WAIT = 3000;
    const LLM_TIMEOUT = 30000;
    const MAX_LLM_RETRY = 2;
    const AUTO_SUBMIT_QUIZ = true;
    const CONFIRM_BEFORE_SUBMIT = false;

    // ==================== 伪造时长上报配置 ====================
    const CONCURRENT_COUNT = 50;
    const STEP_SECONDS = 4;
    const BATCH_INTERVAL = 300;
    const MAX_BATCHES = 50;

    // ==================== 跳过列表（ID递增时跳过这些ID） ====================
    const SKIP_IDS = new Set([2119410, 2119427, 2119443, 2119460, 2119472, 2119340, 2119354, 2119376, 2119396]);

    // ==================== 全局状态 ====================
    let hasNavigated = false;
    let hasSetQuality = false;
    let quizInProgress = false;
    let hasHandledQuiz = false;
    let submittingQuiz = false;
    let isRunning = _localStorage.getItem('lms_script_running') !== 'false';

    let progressFakeRunning = false;
    let inferredDuration = 0;
    let batchCount = 0;

    // ==================== 日志系统 ====================
    let logBuffer = [];
    const LOG_STORAGE_KEY = 'lms_script_log';
    const LOG_DATE_KEY = 'lms_script_log_date';

    function getTodayDateString() {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + d;
    }

    function ensureDailyLogStorage() {
        const today = getTodayDateString();
        const savedDate = _localStorage.getItem(LOG_DATE_KEY);
        if (savedDate !== today) {
            _localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify([]));
            _localStorage.setItem(LOG_DATE_KEY, today);
            logBuffer = [];
        }
    }

    function clearLogs(showNotice = true) {
        const today = getTodayDateString();
        logBuffer = [];
        _localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify([]));
        _localStorage.setItem(LOG_DATE_KEY, today);
        if (showNotice) showToast('🧹 日志已清空');
    }

    function log(...args) {
        ensureDailyLogStorage();
        const msg = args.join(' ');
        const time = new Date().toLocaleTimeString();
        const line = '[' + time + '] ' + msg;
        logBuffer.push(line);
        if (logBuffer.length > 500) logBuffer.shift();
        console.log('[LMS]', msg);
        try {
            const existing = JSON.parse(_localStorage.getItem(LOG_STORAGE_KEY) || '[]');
            existing.push(line);
            if (existing.length > 200) existing.splice(0, existing.length - 200);
            _localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(existing));
            _localStorage.setItem(LOG_DATE_KEY, getTodayDateString());
        } catch (_) { }
    }

    function getLogs() { return logBuffer; }

    function downloadLog() {
        ensureDailyLogStorage();
        const all = JSON.parse(_localStorage.getItem(LOG_STORAGE_KEY) || '[]');
        const blob = new Blob([all.join('\n')], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'lms-log-' + new Date().toISOString().slice(0, 10) + '.txt';
        a.click();
        URL.revokeObjectURL(url);
        showToast('📥 日志已下载');
    }

    // ==================== Toast UI ====================
    let toastContainer;

    function initUI() {
        toastContainer = document.createElement('div');
        toastContainer.style.cssText = `
            position: fixed; bottom: 30px; right: 30px; z-index: 9999999;
            display: flex; flex-direction: column; gap: 10px; pointer-events: none;
        `;
        document.body.appendChild(toastContainer);

        const btn = document.createElement('button');
        updateBtnStyle(btn);
        btn.style.cssText += `
            position: fixed; top: 30%; left: 10px; z-index: 9999999;
            padding: 10px 15px; color: white; border: none; border-radius: 8px;
            cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            font-weight: bold; font-size: 14px; transition: all 0.3s;
            opacity: 0.85;
        `;
        btn.onmouseenter = () => { btn.style.opacity = '1'; };
        btn.onmouseleave = () => { btn.style.opacity = '0.85'; };
        btn.onclick = () => {
            isRunning = !isRunning;
            _localStorage.setItem('lms_script_running', isRunning);
            updateBtnStyle(btn);
            showToast(isRunning ? "▶️ 脚本已恢复运行" : "⏸️ 脚本已暂停");
            if (isRunning) {
                hasNavigated = false;
                hasHandledQuiz = false;
                quizInProgress = false;
            }
        };
        document.body.appendChild(btn);

        const settingsBtn = document.createElement('button');
        settingsBtn.innerText = '⚙️';
        settingsBtn.title = 'LLM 设置';
        settingsBtn.style.cssText = `
            position: fixed; top: 30%; left: 10px; z-index: 9999999;
            margin-top: 50px; padding: 8px 12px; color: white;
            background: #607D8B; border: none; border-radius: 8px;
            cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            font-size: 16px; opacity: 0.85;
        `;
        settingsBtn.onmouseenter = () => { settingsBtn.style.opacity = '1'; };
        settingsBtn.onmouseleave = () => { settingsBtn.style.opacity = '0.85'; };
        settingsBtn.onclick = () => openSettingsDialog();
        document.body.appendChild(settingsBtn);

        const logBtn = document.createElement('button');
        logBtn.innerText = '📥';
        logBtn.title = '下载运行日志';
        logBtn.style.cssText = `
            position: fixed; top: 30%; left: 10px; z-index: 9999999;
            margin-top: 92px; padding: 6px 10px; color: white;
            background: #795548; border: none; border-radius: 8px;
            cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            font-size: 11px; opacity: 0.85;
        `;
        logBtn.onmouseenter = () => { logBtn.style.opacity = '1'; };
        logBtn.onmouseleave = () => { logBtn.style.opacity = '0.85'; };
        logBtn.onclick = () => downloadLog();
        document.body.appendChild(logBtn);

        const clearLogBtn = document.createElement('button');
        clearLogBtn.innerText = '🧹';
        clearLogBtn.title = '清空运行日志';
        clearLogBtn.style.cssText = `
            position: fixed; top: 30%; left: 10px; z-index: 9999999;
            margin-top: 126px; padding: 6px 10px; color: white;
            background: #9C27B0; border: none; border-radius: 8px;
            cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            font-size: 11px; opacity: 0.85;
        `;
        clearLogBtn.onmouseenter = () => { clearLogBtn.style.opacity = '1'; };
        clearLogBtn.onmouseleave = () => { clearLogBtn.style.opacity = '0.85'; };
        clearLogBtn.onclick = () => clearLogs(true);
        document.body.appendChild(clearLogBtn);
    }

    function updateBtnStyle(btn) {
        if (isRunning) {
            btn.innerText = 'LMS助手: 运行中';
            btn.style.backgroundColor = '#4CAF50';
        } else {
            btn.innerText = 'LMS助手: 已暂停';
            btn.style.backgroundColor = '#f44336';
        }
    }

    function showToast(text, duration = 3000) {
        if (!toastContainer) return;
        const toast = document.createElement('div');
        toast.innerText = text;
        toast.style.cssText = `
            background: rgba(0, 0, 0, 0.85); color: #fff; padding: 12px 20px;
            border-radius: 6px; box-shadow: 0 4px 8px rgba(0,0,0,0.3);
            font-size: 14px; opacity: 0; transition: opacity 0.4s ease-in-out;
            max-width: 400px; word-wrap: break-word;
        `;
        toastContainer.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '1'; }, 10);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 400);
        }, duration);
    }

    // ==================== LLM 设置对话框 ====================
    function openSettingsDialog() {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.5); z-index: 99999999;
            display: flex; align-items: center; justify-content: center;
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: #fff; border-radius: 12px; padding: 24px; width: 420px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3); font-family: sans-serif;
        `;

        const fields = [
            { label: 'API Base URL', key: 'lms_llm_base_url', val: LLM_CONFIG.base_url },
            { label: 'Model', key: 'lms_llm_model', val: LLM_CONFIG.model },
            { label: 'API Key', key: 'lms_llm_api_key', val: LLM_CONFIG.api_key, type: 'password' },
        ];

        dialog.innerHTML = `
            <h3 style="margin:0 0 16px; color:#333;">⚙️ LLM API 设置</h3>
            <p style="font-size:12px;color:#888;margin-bottom:12px;">
                支持 OpenAI / Deepseek / XiaomiMimo 等兼容接口
            </p>
            ${fields.map(f => `
                <div style="margin-bottom:12px;">
                    <label style="display:block;font-size:13px;font-weight:bold;color:#555;margin-bottom:4px;">${f.label}</label>
                    <input id="lms_setting_${f.key}" type="${f.type || 'text'}"
                        value="${f.val.replace(/"/g, '&quot;')}"
                        style="width:100%;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;box-sizing:border-box;">
                </div>
            `).join('')}
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
                <button id="lms_settings_cancel" style="padding:8px 16px;border:1px solid #ddd;border-radius:6px;background:#f5f5f5;cursor:pointer;">取消</button>
                <button id="lms_settings_save" style="padding:8px 16px;border:none;border-radius:6px;background:#4CAF50;color:#fff;cursor:pointer;font-weight:bold;">保存</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        overlay.querySelector('#lms_settings_cancel').onclick = () => overlay.remove();
        overlay.querySelector('#lms_settings_save').onclick = () => {
            fields.forEach(f => {
                const input = overlay.querySelector('#lms_setting_' + f.key);
                const val = input.value.trim();
                if (val) {
                    _localStorage.setItem(f.key, val);
                    LLM_CONFIG[f.key === 'lms_llm_base_url' ? 'base_url' :
                        f.key === 'lms_llm_model' ? 'model' : 'api_key'] = val;
                }
            });
            showToast('✅ 设置已保存');
            overlay.remove();
        };
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    }

    // ==================== LLM API 调用 ====================
    function callLLM(questions) {
        return new Promise((resolve, reject) => {
            const prompt = buildPrompt(questions);
            log('[LLM] 发送请求, 共' + questions.length + '题, model=' + LLM_CONFIG.model + ', url=' + LLM_CONFIG.base_url);

            const body = JSON.stringify({
                model: LLM_CONFIG.model,
                messages: [
                    {
                        role: 'system',
                        content: '你是一个学习助手。请根据题目内容选择正确答案。你必须严格按指定格式回复，每行一题，不要包含任何其他文字。'
                    },
                    { role: 'user', content: prompt }
                ],
                max_tokens: LLM_CONFIG.max_tokens,
                temperature: LLM_CONFIG.temperature,
            });

            const url = LLM_CONFIG.base_url.replace(/\/+$/, '') + '/chat/completions';

            GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + LLM_CONFIG.api_key,
                },
                data: body,
                timeout: LLM_TIMEOUT,
                onload: function (resp) {
                    try {
                        const data = JSON.parse(resp.responseText);
                        if (data.error) {
                            reject(new Error('API Error: ' + JSON.stringify(data.error)));
                            return;
                        }
                        const content = data.choices?.[0]?.message?.content;
                        if (!content) {
                            reject(new Error('LLM 返回内容为空'));
                            return;
                        }
                        resolve(content.trim());
                    } catch (e) {
                        reject(new Error('解析 LLM 响应失败: ' + e.message));
                    }
                },
                onerror: function () { reject(new Error('LLM 网络请求失败')); },
                ontimeout: function () { reject(new Error('LLM 请求超时')); },
            });
        });
    }

    function buildPrompt(questions) {
        const lines = [
            '请回答以下测验题目。你可以先思考分析，但最后答案必须用{类型,答案}格式写在行末。',
            '类型: judge / choice / multi',
            'judge: T或F（T=正确/对，F=错误/错）',
            'choice: 选项字母如C',
            'multi: 选项字母组合如CD（字母大写无分隔）',
            '最终答案格式: {judge,T} {choice,C} {multi,ABD}',
            '',
        ];

        questions.forEach((q, i) => {
            const shortType = q.type === 'truefalse' ? 'judge' : q.type === 'single' ? 'choice' : q.type === 'multiple' ? 'multi' : q.type;
            lines.push('Q' + (i + 1) + ' (' + shortType + '): ' + q.text);
            if (q.options && q.options.length > 0) {
                const optStrs = q.options.map((opt, j) => {
                    const letter = opt.letter || String.fromCharCode(65 + j);
                    return '  ' + letter + '. ' + opt.label;
                });
                lines.push(optStrs.join('\n'));
            }
            lines.push('');
        });

        lines.push('请给出最终答案（每行用{类型,答案}包裹）：');
        return lines.join('\n');
    }

    function parseLLMResponse(responseText, questions) {
        log('[LLM] 原始返回(首300):', responseText.substring(0, 300));
        const text = responseText.trim();

        const matches = text.match(/\{(judge|choice|multi)\s*[,，]\s*([^}]+)\}/gi);
        if (!matches || matches.length === 0) {
            log('[LLM] 未找到{}包裹答案，尝试按行解析');
            return parseLines(responseText, questions);
        }

        const result = [];
        matches.forEach(m => {
            const inner = m.replace(/[{}]/g, '').trim();
            const parts = inner.split(/[,，\s]+/);
            if (parts.length >= 2) {
                const type = parts[0].toLowerCase();
                const answer = parts.slice(1).join('').toUpperCase();
                result.push({ type, answer });
            }
        });

        while (result.length < questions.length) result.push(null);
        log('[LLM] 解析结果(' + result.filter(r => r).length + '条):',
            result.map(r => r ? r.type + ',' + r.answer : 'null').join(' | '));
        return result;
    }

    function parseLines(text, questions) {
        const lines = text.split('\n').filter(l => l.trim());
        const result = [];
        const validTypes = ['judge', 'choice', 'multi'];

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();

            if (/^(题目|以下是|请|答案|回答|注|注意)/.test(line)) continue;
            if (/^Q\d/.test(line) && !/[,，]/.test(line)) continue;

            line = line.replace(/[{}（）()【】\[\]]/g, '').trim();

            let match = line.match(/^(judge|choice|multi|判断|单选|多选)\s*[,，:：]\s*(.+)$/i);
            if (!match) {
                if (/^[TF]$/i.test(line) && questions[result.length]?.type === 'judge') {
                    result.push({ type: 'judge', answer: line.toUpperCase() });
                    continue;
                }
                if (/^[A-E]$/i.test(line) && questions[result.length]?.type === 'choice') {
                    result.push({ type: 'choice', answer: line.toUpperCase() });
                    continue;
                }
                if (/^[A-E]{2,}$/i.test(line) && questions[result.length]?.type === 'multi') {
                    result.push({ type: 'multi', answer: line.toUpperCase() });
                    continue;
                }
                const stripped = line.replace(/[0-9]/g, '');
                if (/^[TF]$/i.test(stripped)) {
                    result.push({ type: 'judge', answer: stripped.toUpperCase() });
                    continue;
                }
                result.push(null);
                continue;
            }

            const typeRaw = match[1].toLowerCase();
            const answer = match[2].trim().toUpperCase().replace(/\s+/g, '');
            const type = typeRaw === '判断' ? 'judge' : typeRaw === '单选' ? 'choice' : typeRaw === '多选' ? 'multi' : typeRaw;

            if (!validTypes.includes(type)) { result.push(null); continue; }
            result.push({ type, answer });
        }

        while (result.length < questions.length) result.push(null);
        log('[LLM] 解析结果(' + result.filter(r => r).length + '条):',
            result.map(r => r ? r.type + ',' + r.answer : 'null').join(' | '));
        return result;
    }

    // ==================== 测验检测与题目提取 ====================
    function isQuizViewPage() { return window.location.href.includes('/mod/quiz/view.php'); }
    function isAttemptPage() { return window.location.href.includes('/mod/quiz/attempt.php'); }
    function isSummaryPage() { return window.location.href.includes('/mod/quiz/summary.php'); }
    function isReviewPage() { return window.location.href.includes('/mod/quiz/review.php'); }

    function extractQuestions() {
        log('[extract] 开始提取题目...');
        const questions = [];
        const mainEl = document.querySelector('[role="main"]') || document.querySelector('#region-main') || document.body;

        const headings = mainEl.querySelectorAll('h3, h4');
        const qBlocks = [];

        headings.forEach(h => {
            const text = h.innerText.trim();
            if (/^试题\s*\d+$/.test(text)) {
                const parent = h.closest('div[id]') || h.parentElement;
                if (parent) qBlocks.push(parent);
            }
        });

        if (qBlocks.length === 0) {
            mainEl.querySelectorAll('h3').forEach(h => {
                const text = h.innerText.trim();
                if (/^试题\s*\d+$/.test(text)) {
                    let current = h.parentElement;
                    while (current && current !== mainEl && current !== document.body) {
                        const radioBtns = current.querySelectorAll('input[type="radio"]');
                        const checkBoxes = current.querySelectorAll('input[type="checkbox"]');
                        if (radioBtns.length > 0 || checkBoxes.length > 0) {
                            qBlocks.push(current);
                            break;
                        }
                        current = current.parentElement;
                    }
                }
            });
        }

        const uniqueBlocks = [];
        qBlocks.forEach(b => { if (!uniqueBlocks.includes(b)) uniqueBlocks.push(b); });
        uniqueBlocks.forEach((block, idx) => {
            const q = extractSingleQuestion(block, idx);
            if (q) questions.push(q);
        });

        log('[extract] 共提取 ' + questions.length + ' 题');
        questions.forEach((q, i) => log('[extract] Q' + (i + 1) + ' type=' + q.type + ' text=' + q.text.substring(0, 60)));
        return questions;
    }

    function extractSingleQuestion(el, idx) {
        let text = '';
        const texts = [];
        const h4 = el.querySelector('h4[id*="question"]');
        if (h4) {
            let next = h4.nextElementSibling;
            while (next && next.tagName !== 'DIV' && next.tagName !== 'FIELDSET') {
                if (next.innerText && !next.querySelector('h3,h4')) texts.push(next.innerText.trim());
                next = next.nextElementSibling;
            }
        }

        if (texts.length === 0) {
            const qtextEl = el.querySelector('.qtext, .questiontext');
            if (qtextEl) {
                text = qtextEl.innerText.trim();
            } else {
                const allText = el.innerText;
                const lines = allText.split('\n').filter(l => {
                    const t = l.trim();
                    if (!t) return false;
                    if (/^(判断题|选择题|多选题|还未作答|答案已保存|满分|得分|正确|不正确|标记试题|选择一项|请选择多个)/.test(t)) return false;
                    if (/^[A-E]\./.test(t) && t.length < 30) return false;
                    if (/^(对|错)$/.test(t)) return false;
                    return true;
                });
                text = lines.join(' ').substring(0, 500);
            }
        } else {
            text = texts.join(' ');
        }

        text = text.replace(/\s+/g, ' ').trim();
        if (!text || text.length < 3) return null;

        let type = 'choice';
        const typeLabelEl = el.querySelector('[class*="state"], .state, .info .state');
        if (typeLabelEl) {
            const typeText = typeLabelEl.innerText.trim();
            if (typeText.includes('多选')) type = 'multi';
            else if (typeText.includes('判断')) type = 'judge';
            else if (typeText.includes('选择')) type = 'choice';
        }

        const options = [];
        const radios = el.querySelectorAll('input[type="radio"]');
        const checkboxes = el.querySelectorAll('input[type="checkbox"]');

        if (radios.length > 0) {
            radios.forEach(r => {
                const parent = r.closest('div, label');
                if (!parent) return;
                const labelText = parent.innerText.trim();
                if (labelText === '对' || labelText === '错') {
                    if (!options.some(o => o.label === labelText))
                        options.push({ letter: labelText === '对' ? 'T' : 'F', index: options.length, label: labelText, radio: r });
                } else {
                    const letterMatch = labelText.match(/^([A-E])\./);
                    if (letterMatch) {
                        const letter = letterMatch[1];
                        const content = labelText.replace(/^[A-E]\.\s*/, '').trim();
                        if (!options.some(o => o.letter === letter))
                            options.push({ letter, index: options.length, label: content, radio: r });
                    }
                }
            });
            if (options.length === 2 && options.every(o => o.label === '对' || o.label === '错')) {
                type = 'judge';
            } else {
                type = 'choice';
            }
        }

        if (checkboxes.length > 0) {
            type = 'multi';
            checkboxes.forEach(cb => {
                const parent = cb.closest('div, label');
                if (!parent) return;
                const labelText = parent.innerText.trim();
                const letterMatch = labelText.match(/^([A-E])\./);
                if (letterMatch) {
                    const letter = letterMatch[1];
                    const content = labelText.replace(/^[A-E]\.\s*/, '').trim();
                    if (!options.some(o => o.letter === letter))
                        options.push({ letter, index: options.length, label: content, checkbox: cb });
                }
            });
        }

        return { text, options, type, element: el, index: idx };
    }

    // ==================== 作答 ====================
    function selectAnswers(parsedAnswers, questions) {
        let filled = 0;
        log('[select] 开始填入答案...');
        questions.forEach((q, i) => {
            const parsed = parsedAnswers[i];
            if (!parsed || !parsed.answer) {
                console.warn('[LMS] 题目' + (i + 1) + '无答案，跳过');
                return;
            }

            const ans = parsed.answer.toUpperCase();
            const opts = q.options;
            log('[select] Q' + (i + 1) + ' type=' + q.type + ' LLM-ans=' + ans + ' opts=' + opts.length);

            if (q.type === 'judge') {
                const targetLabel = (ans === 'T' || ans === 'TRUE' || ans === '对' || ans === '正确') ? '对' : '错';
                const opt = opts.find(o => o.label === targetLabel);
                if (opt && opt.radio) {
                    opt.radio.checked = true;
                    opt.radio.dispatchEvent(new Event('change', { bubbles: true }));
                    filled++;
                }
            } else if (q.type === 'choice') {
                const opt = opts.find(o => o.letter === ans);
                if (opt && opt.radio) {
                    opt.radio.checked = true;
                    opt.radio.dispatchEvent(new Event('change', { bubbles: true }));
                    filled++;
                }
            } else if (q.type === 'multi') {
                const letters = ans.split('').filter(ch => /[A-E]/.test(ch));
                opts.forEach(opt => {
                    if (opt.checkbox) {
                        opt.checkbox.checked = letters.includes(opt.letter);
                        if (letters.includes(opt.letter)) filled++;
                    }
                });
            }
        });

        showToast('✅ 已填入 ' + filled + ' 个选项');
        log('[select] 完成: ' + filled + ' 个选项已选中');
    }

    // ==================== 提交流程 ====================
    function clickStartAttempt() {
        const startBtn = document.querySelector('button[id*="single_button"], form button[type="submit"][value*="开始"]')
            || Array.from(document.querySelectorAll('button')).find(b => /开始作答/.test(b.innerText))
            || Array.from(document.querySelectorAll('input[type="submit"]')).find(b => /开始作答/.test(b.value));

        if (startBtn) {
            showToast('📝 点击"开始作答"...');
            startBtn.click();
            setTimeout(() => { clickPreflightConfirm(); }, 800);
            return true;
        }
        return false;
    }

    function clickPreflightConfirm() {
        const dialog = document.querySelector('.moodle-dialogue:not(.moodle-dialogue-hidden), [role="dialog"]:not([aria-hidden="true"])');
        if (dialog) {
            const confirmBtn = dialog.querySelector('input[type="submit"][value*="开始"]')
                || dialog.querySelector('button[value*="开始"]')
                || Array.from(dialog.querySelectorAll('button')).find(b => /开始作答/.test(b.innerText));
            if (confirmBtn) {
                showToast('📝 确认开始作答...');
                confirmBtn.click();
                return true;
            }
        }
        const allInputs = document.querySelectorAll('input[type="submit"]');
        for (const inp of allInputs) {
            if (/开始作答/.test(inp.value) && inp.offsetParent !== null) {
                inp.click();
                return true;
            }
        }
        return false;
    }

    function clickEndAttempt() {
        const endBtn = Array.from(document.querySelectorAll('button, a, input[type="submit"]')).find(b =>
            /结束作答/.test(b.innerText || b.value || '')
        );
        if (endBtn) {
            showToast('📤 结束作答，进入概要页...');
            endBtn.click();
            return true;
        }
        return false;
    }

    function clickSubmitAll() {
        const submitBtn = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn')).find(b =>
            /全部提交并结束/.test(b.innerText || b.value || '')
        );
        if (submitBtn) {
            log('[submit] 找到页面提交按钮:', submitBtn.tagName, (submitBtn.innerText || submitBtn.value).trim());
            showToast('📤 提交所有答案...');
            submittingQuiz = true;
            submitBtn.click();
            waitForDialogAndConfirm(0);
            return true;
        }
        log('[submit] 未找到"全部提交并结束"按钮');
        return false;
    }

    function waitForDialogAndConfirm(retry) {
        if (retry > 20) { log('[submit] 超时'); submittingQuiz = false; return; }

        const dialogBd = document.querySelector('.moodle-dialogue-confirm .moodle-dialogue-bd, .moodle-dialogue-base .moodle-dialogue-bd');
        if (dialogBd && dialogBd.offsetParent !== null) {
            const dialogBtn = dialogBd.querySelector('input[type="button"][value*="提交"], input[type="submit"][value*="提交"], button');
            if (dialogBtn && /全部提交并结束/.test(dialogBtn.value || dialogBtn.innerText || '')) {
                log('[submit] 在.dialogue-bd中找到弹窗按钮:', (dialogBtn.value || dialogBtn.innerText).trim());
                showToast('📤 确认提交...');
                dialogBtn.click();
                submittingQuiz = false;
                return;
            }
        }

        const allCandidates = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]')).filter(b => {
            const txt = (b.innerText || b.value || '').trim();
            return /全部提交并结束/.test(txt) && b.offsetParent !== null && !b.disabled;
        });

        log('[submit] 轮询#' + retry + ' 找到' + allCandidates.length + '个可见候选按钮');

        if (allCandidates.length >= 2) {
            const dialogBtn = allCandidates.find(b => {
                const inDialog = b.closest('.moodle-dialogue-confirm, .moodle-dialogue-base, [role="dialog"], dialog, .yui3-panel');
                if (inDialog && inDialog.offsetParent !== null) return true;
                const parent = b.parentElement;
                if (!parent) return false;
                const siblings = parent.querySelectorAll('input[type="button"], input[type="submit"], button');
                return Array.from(siblings).some(s => /取消/.test(s.value || s.innerText || ''));
            }) || allCandidates[allCandidates.length - 1];

            log('[submit] 选中弹窗按钮:', (dialogBtn.value || dialogBtn.innerText).trim());
            showToast('📤 确认提交...');
            dialogBtn.click();
            submittingQuiz = false;
            return;
        }

        if (allCandidates.length === 1 && retry > 5) {
            log('[submit] 仅1个按钮且等待足够，直接点击');
            allCandidates[0].click();
            submittingQuiz = false;
            return;
        }

        const htmlDialog = document.querySelector('dialog[open]');
        if (htmlDialog) {
            const btn = Array.from(htmlDialog.querySelectorAll('button, input[type="submit"], input[type="button"]')).find(b =>
                /全部提交并结束/.test(b.innerText || b.value || '')
            );
            if (btn) {
                log('[submit] 在<dialog>中找到按钮');
                btn.click();
                submittingQuiz = false;
                return;
            }
        }

        setTimeout(() => waitForDialogAndConfirm(retry + 1), 500);
    }

    function getReviewScore() {
        const tableRows = document.querySelectorAll('table tr');
        for (const row of tableRows) {
            const text = row.innerText.trim();
            if (/评分/.test(text)) {
                const match = text.match(/(\d+\.?\d*)\s*\/\s*(\d+\.?\d*)/);
                if (match) return { score: parseFloat(match[1]), total: parseFloat(match[2]) };
                const pctMatch = text.match(/(\d+)%/);
                if (pctMatch) {
                    const pct = parseInt(pctMatch[1]);
                    return { score: pct, total: 100, percent: pct };
                }
            }
        }
        return null;
    }

    function clickEndReview() {
        const endBtn = Array.from(document.querySelectorAll('button, a')).find(b =>
            /结束回顾/.test(b.innerText || '')
        );
        if (endBtn) { endBtn.click(); return true; }
        return false;
    }

    // ==================== 自动推进（点击跳转） ====================
   async function jumpToNextActivity() {
    // 1. 查找“下一页”按钮
    const nextLink = document.getElementById('next-activity-link');
    if (!nextLink) {
        log('[jump] 未找到下一页按钮，停止跳转');
        return;
    }

    // 2. 检查是否需要执行刷新后的跳转
    const refreshPending = sessionStorage.getItem('lms_jump_refresh_pending');
    if (refreshPending === 'true') {
        // 刷新后：清除标记，重新获取按钮，直接点击跳转
        sessionStorage.removeItem('lms_jump_refresh_pending');
        log('[jump] 刷新后，重新获取按钮并跳转');
        const newNextLink = document.getElementById('next-activity-link');
        if (!newNextLink) {
            log('[jump] 刷新后未找到下一页按钮');
            return;
        }
        log('[jump] 执行跳转');
        hasNavigated = true;
        newNextLink.click();
        return;
    }

    // 3. 未设置 pending：先刷新页面，等待刷新后自动跳转
    log('[jump] 刷新页面后自动跳转');
    sessionStorage.setItem('lms_jump_refresh_pending', 'true');
    location.reload();
}
// 辅助函数：请求目标页面文本，检查是否包含关键词
function checkPageForKeywords(url, keywords) {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            timeout: 5000,
            onload: function(resp) {
                const text = resp.responseText;
                const found = keywords.some(kw => text.includes(kw));
                resolve(found);
            },
            onerror: function(e) {
                reject(e);
            },
            ontimeout: function() {
                reject(new Error('timeout'));
            }
        });
    });
}
    // ==================== LLM 答题流程 ====================
    let quizRetryCount = 0;
    const MAX_QUIZ_RETRY = 2;

    async function handleQuiz() {
        if (quizInProgress) return false;
        quizInProgress = true;
        _sessionStorage.removeItem('lms_video_ended_refresh');

        const url = window.location.href;
        log('[quiz] 进入测验流程, url=' + url);

        // ---- 阶段1: view.php → 点击"开始作答" ----
        if (isQuizViewPage()) {
            if (hasHandledQuiz) {
                log('[quiz] view.php 但已答过题，跳过测验 → 跳转下一节');
                jumpToNextActivity();
                quizInProgress = false;
                return true;
            }
            // 新增：先刷新一次页面
            if (!_sessionStorage.getItem('lms_quiz_refreshed')) {
                _sessionStorage.setItem('lms_quiz_refreshed', '1');
                log('[quiz] 阶段1: 先刷新页面...');
                showToast('📝 检测到测验，刷新页面后再开始作答...');
                location.reload();
                quizInProgress = false;
                return true;
            }
            _sessionStorage.removeItem('lms_quiz_refreshed');
            log('[quiz] 阶段1: view.php → 点击开始作答');
            showToast('📝 检测到测验概览页，准备开始作答...');
            await sleep(600);
            if (clickStartAttempt()) {
                showToast('⏳ 等待进入答题页...');
            } else {
                showToast('⚠️ 未找到"开始作答"按钮', 5000);
            }
            quizInProgress = false;
            return false;
        }

        // ---- 阶段2: attempt.php → 提取题目 + LLM作答 ----
        if (isAttemptPage()) {
            log('[quiz] 阶段2: attempt.php → 提取题目+LLM作答');
            if (hasHandledQuiz) { quizInProgress = false; return false; }

            showToast('📝 答题页：正在提取题目...');
            await sleep(800);

            const questions = extractQuestions();
            if (questions.length === 0) {
                showToast('⚠️ 未能提取到题目，可能还在preflight弹窗...');
                clickPreflightConfirm();
                quizInProgress = false;
                return false;
            }

            showToast('📋 共 ' + questions.length + ' 道题，调用 LLM 作答...');

            if (!LLM_CONFIG.api_key || LLM_CONFIG.api_key === '') {
                showToast('⚠️ 请先设置 LLM API Key！点击左侧 ⚙️ 按钮', 8000);
                quizInProgress = false;
                return false;
            }

            let parsedAnswers = null;
            for (let attempt = 0; attempt <= MAX_LLM_RETRY; attempt++) {
                try {
                    if (attempt > 0) {
                        showToast('🔄 LLM 重试 (' + attempt + '/' + MAX_LLM_RETRY + ')...');
                        await sleep(2000);
                    }
                    const responseText = await callLLM(questions);
                    console.log('[LMS] LLM 原始返回:', responseText);
                    parsedAnswers = parseLLMResponse(responseText, questions);
                    console.log('[LMS] 解析结果:', parsedAnswers);
                    break;
                } catch (e) {
                    console.error('[LMS] LLM 失败:', e);
                    if (attempt >= MAX_LLM_RETRY) {
                        showToast('❌ LLM 答题失败: ' + e.message, 8000);
                        quizInProgress = false;
                        return false;
                    }
                }
            }

            if (!parsedAnswers || parsedAnswers.filter(a => a !== null).length === 0) {
                showToast('❌ LLM 未返回有效答案', 8000);
                quizInProgress = false;
                return false;
            }

            selectAnswers(parsedAnswers, questions);
            hasHandledQuiz = true;

            await sleep(500);
            showToast('📤 正在结束作答...');
            clickEndAttempt();

            quizInProgress = false;
            return true;
        }

        // ---- 阶段3: summary.php → 提交 ----
        if (isSummaryPage()) {
            if (submittingQuiz) { quizInProgress = false; return false; }
            log('[quiz] 阶段3: summary.php → 提交');
            showToast('📋 作答概要，准备提交...');
            await sleep(600);
            const checkBoxes = document.querySelectorAll('input[type="checkbox"]');
            const confirmCheckbox = Array.from(checkBoxes).find(cb =>
                /确认|确认提交|不再修改/i.test(cb.parentElement?.innerText || '')
            );
            if (confirmCheckbox && !confirmCheckbox.checked) confirmCheckbox.checked = true;
            clickSubmitAll();
            quizInProgress = false;
            return true;
        }

        // ---- 阶段4: review.php → 查看得分 ----
        if (isReviewPage()) {
            log('[quiz] 阶段4: review.php → 查看得分');
            await sleep(600);
            const scoreResult = getReviewScore();
            if (scoreResult) {
                log('[quiz] 得分:', JSON.stringify(scoreResult));
                const score = scoreResult.score;
                const total = scoreResult.total;
                const pct = scoreResult.percent || Math.round(score / total * 100);
                showToast('📊 得分: ' + score + '/' + total + ' (' + pct + '%)', 5000);

                if (pct >= 100) {
                    showToast('🎉 满分通过！', 5000);
                }

                // 直接URL递增跳转
                jumpToNextActivity();
                quizInProgress = false;
                return true;
            }

            await sleep(500);
            clickEndReview();
            // 等待后直接递增跳转
            setTimeout(() => jumpToNextActivity(), 1500);
            quizInProgress = false;
            return true;
        }

        quizInProgress = false;
        return false;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ==================== 导航辅助 ====================
    function checkApiKeyConfigured() {
        if (!LLM_CONFIG.api_key || LLM_CONFIG.api_key === '') {
            if (window.location.href.includes('/course/view.php') || isQuizViewPage() || isAttemptPage()) {
                showToast('⚠️ LLM API Key 未配置！点击左侧 ⚙️ 按钮设置。支持 Deepseek/OpenAI/XiaomiMimo 等平台', 10000);
            }
        }
    }

    // ==================== 伪造时长上报（使用页面 jQuery） ====================
    function sendOneProgress(seconds, id) {
        return new Promise((resolve) => {
            const win = unsafeWindow;
            const playerdata = win.playerdata;
            if (!playerdata) {
                resolve({ id, progress: 0, totaltime: 0, duration: 0, success: false });
                return;
            }

            var data = [{
                'index': 0,
                'methodname': 'mod_fsresource_set_time',
                'args': {
                    'fsresourceid': playerdata.fsresourceid,
                    'time': seconds,
                    'finish': 1,
                    'progress': 100,
                    'unique': Date.now() + '_' + Math.random() + '_' + id
                }
            }];

            $.ajax({
                url: playerdata.siteUrl +
                    '/lib/ajax/service.php?timestamp=' + new Date().getTime() +
                    '&sesskey=' + playerdata.sesskey,
                method: 'POST',
                data: JSON.stringify(data),
                success: function(resp) {
                    try {
                        const response = typeof resp === 'string' ? JSON.parse(resp) : resp;
                        const progress = parseFloat(response[0]?.data?.progress) || 0;
                        const totaltime = parseInt(response[0]?.data?.totaltime) || 0;
                        const duration = parseInt(response[0]?.data?.duration) || 0;
                        resolve({ id, progress, totaltime, duration, success: true });
                    } catch(e) {
                        resolve({ id, progress: 0, totaltime: 0, duration: 0, success: false });
                    }
                },
                error: function() {
                    resolve({ id, progress: 0, totaltime: 0, duration: 0, success: false });
                }
            });
        });
    }

    async function sendBatchProgress(count) {
        const promises = [];
        for (let i = 0; i < count; i++) promises.push(sendOneProgress(STEP_SECONDS, i + 1));
        const results = await Promise.all(promises);
        return {
            successCount: results.filter(r => r.success).length,
            maxProgress:  Math.max(...results.map(r => r.progress), 0),
            maxTotalTime: Math.max(...results.map(r => r.totaltime), 0),
            duration:     Math.max(...results.map(r => r.duration), 0),
        };
    }

    function tryInferDuration(progressBefore, progressAfter, sentCount) {
        const gain = progressAfter - progressBefore;
        if (gain <= 0) return 0;
        const inferred = Math.round((sentCount * STEP_SECONDS) / (gain / 100));
        log('[progress] 反推总时长: ' + (sentCount * STEP_SECONDS) + 's / ' + gain.toFixed(2) + '% ≈ ' + inferred + 's');
        return inferred;
    }

    function calcNeeded(currentTotalTime) {
        if (!inferredDuration) return CONCURRENT_COUNT;
        const remaining = inferredDuration - currentTotalTime;
        if (remaining <= 0) return 1;
        const needed = Math.ceil(remaining / STEP_SECONDS);
        log('[progress] 剩余: ' + remaining + 's → 需发 ' + needed + ' 个请求');
        return Math.min(needed, CONCURRENT_COUNT);
    }

    async function runProgressFaker() {
        if (progressFakeRunning) return;
        progressFakeRunning = true;
        inferredDuration = 0;
        batchCount = 0;

        log('[progress] 启动伪造时长上报...');
        showToast('⏱️ 开始自动刷进度...');

        const probe = await sendOneProgress(0, 'probe');
        let currentProgress = probe.progress;
        let currentTotalTime = probe.totaltime;
        if (probe.duration > 0) inferredDuration = probe.duration;

        log('[progress] 初始进度: ' + currentProgress + '% | 已观看: ' + currentTotalTime + 's | 总时长: ' + (inferredDuration || '待推算') + 's');

        while (currentProgress < 100 && batchCount < MAX_BATCHES) {
            batchCount++;
            const needed = inferredDuration ? calcNeeded(currentTotalTime) : CONCURRENT_COUNT;

            log('[progress] 第' + batchCount + '批 发送' + needed + '个请求...');
            const { successCount, maxProgress, maxTotalTime, duration } = await sendBatchProgress(needed);

            if (duration > 0 && !inferredDuration) {
                inferredDuration = duration;
                log('[progress] 接口返回总时长: ' + inferredDuration + 's');
            }

            if (maxProgress > currentProgress) {
                const increase = (maxProgress - currentProgress).toFixed(1);
                log('[progress] 成功' + successCount + '/' + needed + ' | 进度: ' + currentProgress + '% → ' + maxProgress + '% (+' + increase + '%) | 累计' + maxTotalTime + 's');
                showToast('📈 进度: ' + currentProgress.toFixed(1) + '% → ' + maxProgress.toFixed(1) + '%');

                if (!inferredDuration) inferredDuration = tryInferDuration(currentProgress, maxProgress, needed);
                currentProgress = maxProgress;
                currentTotalTime = maxTotalTime;
            } else {
                log('[progress] 进度未增长，当前' + currentProgress + '%');
            }

            const progressSpanEl = document.querySelector('.num-bfjd span');
            const totalTimeEl    = document.querySelector('.num-gksc span');
            if (progressSpanEl) progressSpanEl.innerHTML = Math.floor(currentProgress);
            if (maxTotalTime && totalTimeEl) totalTimeEl.innerHTML = maxTotalTime;

            if (currentProgress >= 100) break;

            await new Promise(resolve => setTimeout(resolve, BATCH_INTERVAL));
        }

        if (currentProgress >= 100) {
            log('[progress] 🎉 达到100%！总批次: ' + batchCount + ' | 推算总时长: ' + inferredDuration + 's');
            showToast('🎉 进度已达100%！');
            const progressSpanEl = document.querySelector('.num-bfjd span');
            if (progressSpanEl) progressSpanEl.innerHTML = '100';
            progressFakeRunning = false;
            setTimeout(() => jumpToNextActivity(), 1000);
        } else {
            log('[progress] 已达最大批次上限，当前进度: ' + currentProgress + '%');
            progressFakeRunning = false;
        }
    }

    // ==================== 主循环 ====================
    initUI();

    if (isRunning) {
        showToast('▶️ LMS 自动学习助手已启动 (无焦点检测版)');
        setTimeout(checkApiKeyConfigured, 3000);
    }

    let mainLoop = setInterval(() => {
        if (!isRunning || hasNavigated) return;

        const url = window.location.href;

        // 0. 测验流程优先处理
        if (url.includes('/mod/quiz/') && !quizInProgress) {
            handleQuiz();
            return;
        }

        // 1. 讨论页面跳过（直接用ID递增）
        const isForumPage = url.includes('/mod/forum/view.php') ||
            document.body.id === 'page-mod-forum-view';

        if (isForumPage) {
            showToast('⏭️ 检测到讨论页，自动跳过...');
            hasNavigated = true;
            clearInterval(mainLoop);
            setTimeout(() => jumpToNextActivity(), SKIP_FORUM_DELAY);
            return;
        }

        // 2. 视频页：重置测验状态 + 自动超清
        if (hasHandledQuiz && url.includes('/mod/fsresource/view.php')) {
            hasHandledQuiz = false;
        }

        const qualityContainer = document.querySelector('.tcp-video-quality-switcher');
        if (qualityContainer && !hasSetQuality) {
            const qualityTextElem = qualityContainer.querySelector('.tcp-quality-switcher-value p');
            if (qualityTextElem && qualityTextElem.innerText.trim() !== '超清') {
                const hdOption = Array.from(qualityContainer.querySelectorAll('.vjs-menu-item'))
                    .find(el => el.innerText.includes('超清'));
                if (hdOption) {
                    showToast('⚙️ 正在自动切换为【超清】画质...');
                    hdOption.click();
                } else {
                    showToast('⚠️ 未找到【超清】选项，保持默认画质');
                }
            }
            hasSetQuality = true;
        }

        // 3. 视频页：伪造时长上报
        if (url.includes('/mod/fsresource/view.php') && !progressFakeRunning) {
            const win = unsafeWindow;
            if (win.playerdata && win.playerdata.fsresourceid) {
                runProgressFaker();
            }
        }

        // 4. 进度完成与自动跳转
        const progressSpan = document.querySelector('.num-bfjd span');
        const statusSpan = document.querySelector('.tips-completion');
        const hasProgressTracker = !!progressSpan || !!statusSpan;
        const progress = progressSpan ? parseFloat(progressSpan.innerText) : 0;
        const isCompletedText = statusSpan ? statusSpan.innerText.trim() === '已完成' : false;
        const video = document.querySelector('video');
        const isVideoEnded = video ? video.ended : false;

        let isTrulyCompleted = false;
        if (video) {
            if (hasProgressTracker) {
                if (progress >= 100 || isCompletedText) isTrulyCompleted = true;
            } else if (isVideoEnded) {
                isTrulyCompleted = true;
            }
        } else if (hasProgressTracker) {
            if (progress >= 100 || isCompletedText) isTrulyCompleted = true;
        }

        if (isTrulyCompleted) {
            const refreshFlag = _sessionStorage.getItem('lms_video_ended_refresh');
            if (video && !refreshFlag) {
                _sessionStorage.setItem('lms_video_ended_refresh', '1');
                log('[video] 完成条件满足，' + (VIDEO_END_WAIT / 1000) + '秒后刷新页面');
                showToast('📺 本节已完成，' + (VIDEO_END_WAIT / 1000) + '秒后刷新页面更新下一活动...');
                hasNavigated = true;
                clearInterval(mainLoop);
                setTimeout(() => location.reload(), VIDEO_END_WAIT);
                return;
            }
            if (video) {
                log('[video] 页面已刷新，清除刷新标记');
                _sessionStorage.removeItem('lms_video_ended_refresh');
            }
            _sessionStorage.removeItem('lms_video_ended_refresh');

            // 直接ID递增跳转
            showToast('✅ 学习任务完成！即将跳转...');
            hasNavigated = true;
            clearInterval(mainLoop);
            setTimeout(() => jumpToNextActivity(), DELAY_BEFORE_NEXT);
            return;
        }

        // 5. 非视频页面的自动推进
        if (!video && !hasProgressTracker && !url.includes('/mod/quiz/') && !isForumPage) {
            const completionCheck = document.querySelector('.completion-info, [class*="completion"]');
            const isComplete = completionCheck && /已完成|完成|✓|✔|complete/i.test(completionCheck.innerText);
            if (isComplete) {
                showToast('✅ 本节已完成，即将跳转...');
                hasNavigated = true;
                clearInterval(mainLoop);
                setTimeout(() => jumpToNextActivity(), DELAY_BEFORE_NEXT);
            }
        }

    }, CHECK_INTERVAL);

})();