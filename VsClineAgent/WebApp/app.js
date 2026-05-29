'use strict';

// ─── State ───────────────────────────────────────────────
const state = {
  status: 'idle',
  workspaceRoot: '',
  activeFile: '',
  settings: null,
  isRunning: false,
  pendingApproval: null,
};

// ─── DOM refs ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const messages = $('messages');
const input = $('input');
const btnSend = $('btn-send');
const btnStop = $('btn-stop');
const btnClear = $('btn-clear');
const btnSettings = $('btn-settings');
const statusDot = $('status-indicator');
const contextBar = $('context-bar');
const settingsPanel = $('settings-panel');
const overlay = $('overlay');
const welcome = $('welcome');

// ─── Bridge ───────────────────────────────────────────────
window.__agentBridge = {
  receive(payload) {
    handleAgentMessage(payload);
  }
};

function postToAgent(msg) {
  window.chrome?.webview?.postMessage(JSON.stringify(msg));
}

// ─── Message handlers ────────────────────────────────────
function handleAgentMessage(msg) {
  switch (msg.type) {
    case 'init':
      state.settings = msg.settings;
      state.workspaceRoot = msg.workspaceRoot || '';
      if (state.workspaceRoot) {
        contextBar.textContent = '📁 ' + state.workspaceRoot;
        contextBar.classList.add('visible');
      }
      applySettingsToUI(msg.settings);
      break;

    case 'settings':
      state.settings = msg.data;
      applySettingsToUI(msg.data);
      break;

    case 'workspaceContext':
      state.workspaceRoot = msg.root || '';
      if (state.workspaceRoot) {
        contextBar.textContent = '📁 ' + state.workspaceRoot;
        contextBar.classList.add('visible');
      }
      break;

    case 'userMessage':
      renderUserMessage(msg.content);
      break;

    case 'assistantMessage':
      hideTypingIndicator();
      renderAssistantMessage(msg.content);
      break;

    case 'toolUse':
      renderToolUse(msg.toolCallId, msg.toolName, msg.arguments);
      break;

    case 'awaitingApproval':
      renderApprovalPrompt(msg.toolCallId, msg.toolName, msg.arguments);
      break;

    case 'toolResult':
      updateToolResult(msg.toolCallId, msg.content, msg.isError);
      break;

    case 'agentStatus':
      setStatus(msg.status);
      if (msg.status === 'thinking') showTypingIndicator();
      else hideTypingIndicator();
      break;

    case 'error':
      hideTypingIndicator();
      renderError(msg.content);
      setStatus('error');
      break;

    case 'taskCompleted':
      hideTypingIndicator();
      renderAssistantMessage(msg.result || 'Task completed.');
      setStatus('idle');
      break;

    case 'askUser':
      hideTypingIndicator();
      renderFollowupQuestion(msg.question, msg.options || []);
      break;

    case 'historyCleared':
      messages.innerHTML = '';
      renderWelcome();
      break;
  }

  scrollToBottom();
}

// ─── Render functions ────────────────────────────────────
function renderWelcome() {
  const div = document.createElement('div');
  div.id = 'welcome-msg';
  div.className = 'msg';
  div.innerHTML = `
    <div style="text-align:center;padding:24px 16px;color:var(--text-muted)">
      <div style="font-size:24px;margin-bottom:8px">🤖</div>
      <div style="font-size:14px;color:var(--text-secondary);font-weight:600;margin-bottom:6px">VS AI Agent</div>
      <div style="font-size:11px">Ask me to read, edit, search files or run commands.<br>Type your request below.</div>
    </div>`;
  messages.appendChild(div);
}

function renderUserMessage(content) {
  removeWelcome();
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.innerHTML = `<div class="msg-role">You</div><div class="msg-content">${escHtml(content)}</div>`;
  messages.appendChild(div);
}

function renderAssistantMessage(content) {
  const div = document.createElement('div');
  div.className = 'msg msg-assistant';
  div.innerHTML = `<div class="msg-role">Agent</div><div class="msg-content">${renderMarkdown(content)}</div>`;
  messages.appendChild(div);
}

function renderToolUse(id, name, argsJson) {
  let argsDisplay = '';
  try {
    const args = JSON.parse(argsJson || '{}');
    argsDisplay = Object.entries(args)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 100) : JSON.stringify(v)}`)
      .join('\n');
  } catch { argsDisplay = argsJson || ''; }

  const div = document.createElement('div');
  div.className = 'msg-tool-use';
  div.dataset.toolId = id;
  div.innerHTML = `
    <div class="tool-header">
      <span class="tool-icon">🔧</span>
      <span class="tool-name">${escHtml(name || '')}</span>
      <span class="tool-status pending" data-status>running...</span>
    </div>
    <div class="tool-args">${escHtml(argsDisplay)}</div>
    <div class="tool-result"></div>`;
  messages.appendChild(div);
}

function renderApprovalPrompt(id, name, argsJson) {
  let argsDisplay = '';
  try {
    const args = JSON.parse(argsJson || '{}');
    argsDisplay = Object.entries(args)
      .map(([k, v]) => `<b>${escHtml(k)}:</b> ${escHtml(String(v).slice(0, 200))}`)
      .join('<br>');
  } catch { argsDisplay = escHtml(argsJson || ''); }

  const div = document.createElement('div');
  div.className = 'approval-prompt';
  div.dataset.approvalId = id;
  div.innerHTML = `
    <div class="approval-title">⚠️ Approve tool: <strong>${escHtml(name || '')}</strong></div>
    <div style="font-size:11px;color:var(--text-secondary);margin:4px 0">${argsDisplay}</div>
    <div class="approval-actions">
      <button class="btn-approve" onclick="approveAction('${id}', true)">✓ Approve</button>
      <button class="btn-reject" onclick="approveAction('${id}', false)">✗ Reject</button>
    </div>`;
  messages.appendChild(div);
  state.pendingApproval = id;
}

function updateToolResult(id, content, isError) {
  const toolDiv = messages.querySelector(`[data-tool-id="${id}"]`);
  if (!toolDiv) return;

  const statusEl = toolDiv.querySelector('[data-status]');
  if (statusEl) {
    statusEl.textContent = isError ? '✗ failed' : '✓ done';
    statusEl.className = 'tool-status ' + (isError ? 'error' : 'success');
  }

  const resultEl = toolDiv.querySelector('.tool-result');
  if (resultEl) {
    const preview = (content || '').slice(0, 300);
    resultEl.textContent = preview + (content.length > 300 ? '\n...(truncated)' : '');
    resultEl.className = 'tool-result visible' + (isError ? ' error-result' : '');
  }

  const approvalDiv = messages.querySelector(`[data-approval-id="${id}"]`);
  if (approvalDiv) approvalDiv.remove();
}

function renderFollowupQuestion(question, options) {
  const div = document.createElement('div');
  div.className = 'followup-question';

  let buttonsHtml = '';
  if (options && options.length > 0) {
    buttonsHtml = `<div class="followup-options">${
      options.map(o => `<button class="followup-option" onclick="answerFollowup(this,'${escHtml(o)}')">${escHtml(o)}</button>`).join('')
    }</div>`;
  }

  div.innerHTML = `
    <div class="followup-header">❓ ${escHtml(question)}</div>
    ${buttonsHtml}
    <div class="followup-input-row">
      <input class="followup-input" type="text" placeholder="Type your answer..." />
      <button class="followup-send" onclick="answerFollowupInput(this)">Send</button>
    </div>`;
  messages.appendChild(div);
}

window.answerFollowup = function(btn, answer) {
  const container = btn.closest('.followup-question');
  if (container) container.remove();
  postToAgent({ type: 'userAnswer', content: answer });
};

window.answerFollowupInput = function(btn) {
  const container = btn.closest('.followup-question');
  const inp = container?.querySelector('.followup-input');
  const answer = inp?.value?.trim() || '';
  if (!answer) return;
  if (container) container.remove();
  postToAgent({ type: 'userAnswer', content: answer });
};

function renderError(msg) {
  const div = document.createElement('div');
  div.className = 'msg-error';
  div.innerHTML = `⚠️ ${escHtml(msg || 'Unknown error')}`;
  messages.appendChild(div);
}

let typingEl = null;
function showTypingIndicator() {
  if (typingEl) return;
  typingEl = document.createElement('div');
  typingEl.className = 'msg msg-assistant';
  typingEl.id = 'typing';
  typingEl.innerHTML = `
    <div class="msg-role">Agent</div>
    <div class="typing-indicator">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>`;
  messages.appendChild(typingEl);
  scrollToBottom();
}
function hideTypingIndicator() {
  if (typingEl) { typingEl.remove(); typingEl = null; }
}

function removeWelcome() {
  const w = $('welcome-msg');
  if (w) w.remove();
}

// ─── Approval ────────────────────────────────────────────
window.approveAction = function(id, approved) {
  postToAgent({ type: approved ? 'approveAction' : 'rejectAction', toolCallId: id });
  const div = messages.querySelector(`[data-approval-id="${id}"]`);
  if (div) div.remove();
  state.pendingApproval = null;
};

// ─── Status ───────────────────────────────────────────────
function setStatus(s) {
  state.status = s;
  state.isRunning = s === 'thinking' || s === 'running';

  statusDot.className = s;
  btnSend.disabled = state.isRunning;
  btnStop.classList.toggle('visible', state.isRunning);
  input.disabled = state.isRunning;
}

// ─── Send ─────────────────────────────────────────────────
function sendMessage() {
  const text = input.value.trim();
  if (!text || state.isRunning) return;
  input.value = '';
  autoResize();
  postToAgent({ type: 'sendMessage', content: text });
}

// ─── Settings ─────────────────────────────────────────────
function applySettingsToUI(s) {
  if (!s) return;
  $('s-baseurl').value   = s.LlmBaseUrl || '';
  $('s-model').value     = s.ModelName || '';
  $('s-apikey').value    = s.ApiKey || '';
  $('s-maxtokens').value = s.MaxTokens || 8192;
  $('s-temp').value      = s.Temperature ?? 0.1;
  $('s-autoapprove').checked = !!s.AutoApprove;
}

function saveSettings() {
  const settings = {
    LlmBaseUrl:   $('s-baseurl').value.trim(),
    ModelName:    $('s-model').value.trim(),
    ApiKey:       $('s-apikey').value.trim(),
    MaxTokens:    parseInt($('s-maxtokens').value) || 8192,
    Temperature:  parseFloat($('s-temp').value) || 0.1,
    AutoApprove:  $('s-autoapprove').checked,
    ShowTokenCount: true,
  };
  postToAgent({ type: 'updateSettings', settings });
  closeSettings();
}

function openSettings() {
  if (!state.settings) postToAgent({ type: 'getSettings' });
  settingsPanel.classList.add('visible');
  overlay.classList.add('visible');
}

function closeSettings() {
  settingsPanel.classList.remove('visible');
  overlay.classList.remove('visible');
}

// ─── Markdown ─────────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';
  let html = escHtml(text);

  // Code blocks
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code.trimEnd()}</code></pre>`);

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);

  // Paragraphs (double newline)
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');

  return `<p>${html}</p>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messages.scrollTop = messages.scrollHeight;
  });
}

// ─── Input auto-resize ────────────────────────────────────
function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

// ─── Event listeners ──────────────────────────────────────
btnSend.addEventListener('click', sendMessage);
btnStop.addEventListener('click', () => postToAgent({ type: 'stopAgent' }));
btnClear.addEventListener('click', () => {
  if (confirm('Clear chat history?')) postToAgent({ type: 'clearHistory' });
});
btnSettings.addEventListener('click', openSettings);
overlay.addEventListener('click', closeSettings);

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
input.addEventListener('input', autoResize);

$('btn-save-settings').addEventListener('click', saveSettings);

// ─── Init ─────────────────────────────────────────────────
renderWelcome();
setStatus('idle');
postToAgent({ type: 'getWorkspaceContext' });
