import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

const el = {
  app: document.getElementById('app'),
  scrim: document.getElementById('scrim'),
  toggleSidebar: document.getElementById('toggle-sidebar'),
  newChat: document.getElementById('new-chat'),
  conversations: document.getElementById('conversations'),
  title: document.getElementById('title'),
  messages: document.getElementById('messages'),
  empty: document.getElementById('empty'),
  status: document.getElementById('status'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
};

// Sent with every message: "today" and "last Tuesday" mean the user's dates.
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const state = {
  // The browser owns the id of a new chat, so the very first request can
  // create it and a failed stream never leaves the page without an id.
  conversationId: crypto.randomUUID(),
  // AbortController of the in-flight answer, or null when idle.
  inflight: null,
};

// Answers may contain links from web pages: open them in a new tab, and never
// give the opened page a handle back to this one.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function renderMarkdown(target, markdown, sources = []) {
  target.innerHTML = DOMPurify.sanitize(marked.parse(markdown));
  linkCitations(target, sources);
}

// Source URLs come from the open web: only ever link plain http(s).
function isWebUrl(url) {
  return /^https?:\/\//i.test(url);
}

function sourceLink(source, text) {
  if (!isWebUrl(source.url)) return document.createTextNode(text);
  const link = document.createElement('a');
  link.href = source.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = text;
  return link;
}

const CITATION = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

// Turns [2] and [1][3] in the rendered answer into links to their sources.
// Works on text nodes after sanitising, so no HTML is built from strings and
// citations inside code or existing links are left alone.
function linkCitations(root, sources) {
  if (!sources.length) return;
  const byNumber = new Map(sources.map((source) => [source.n, source]));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    if (!walker.currentNode.parentElement.closest('code, pre, a')) textNodes.push(walker.currentNode);
  }
  for (const node of textNodes) {
    const text = node.nodeValue;
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(CITATION)) {
      const cited = match[1].split(',').map((n) => byNumber.get(Number(n))).filter(Boolean);
      if (!cited.length) continue;
      fragment.append(text.slice(last, match.index));
      for (const source of cited) {
        const sup = document.createElement('sup');
        sup.className = 'cite';
        sup.title = source.title;
        sup.append(sourceLink(source, String(source.n)));
        fragment.append(sup);
      }
      last = match.index + match[0].length;
    }
    if (last === 0) continue;
    fragment.append(text.slice(last));
    node.replaceWith(fragment);
  }
}

// ---------- Messages ----------

function isNearBottom() {
  const m = el.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
}

// Only follow the stream if the user hasn't scrolled up to read something.
function keepScrolled(wasNearBottom) {
  if (wasNearBottom) el.messages.scrollTop = el.messages.scrollHeight;
}

function addMessage(role, content = '', sources = []) {
  el.empty.hidden = true;
  const wrap = document.createElement('article');
  wrap.className = `message ${role}`;
  const body = document.createElement('div');
  body.className = role === 'assistant' ? 'body markdown' : 'body';
  if (role === 'assistant') renderMarkdown(body, content, sources);
  else body.textContent = content;
  wrap.append(body);
  el.messages.append(wrap);
  if (sources.length) renderSources(wrap, sources);
  return { wrap, body };
}

function renderSources(wrap, sources) {
  wrap.querySelector('.sources')?.remove();
  if (!sources.length) return;
  const list = document.createElement('ol');
  list.className = 'sources';
  for (const source of sources) {
    const item = document.createElement('li');
    item.value = source.n;
    const link = sourceLink(source, source.title || source.url);
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = safeHost(source.url);
    item.append(link, host);
    list.append(item);
  }
  wrap.append(list);
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function addNote(wrap, text, kind) {
  const note = document.createElement('p');
  note.className = `note ${kind}`;
  note.textContent = text;
  wrap.append(note);
}

function clearMessages() {
  el.messages.replaceChildren(el.empty);
  el.empty.hidden = false;
}

// ---------- Status line ----------

function setStatus(text) {
  el.status.textContent = text ?? '';
  el.status.hidden = !text;
}

// ---------- Sidebar ----------

async function loadConversations() {
  const response = await fetch('/api/conversations');
  if (!response.ok) return;
  const conversations = await response.json();
  el.conversations.replaceChildren(
    ...conversations.map((conversation) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = conversation.title;
      button.title = conversation.title;
      button.dataset.id = conversation.id;
      button.addEventListener('click', () => openConversation(conversation.id));
      item.append(button);
      return item;
    }),
  );
  markActive();
}

// Also syncs the header, which is how a new chat picks up its title once the
// server has created it.
function markActive() {
  for (const button of el.conversations.querySelectorAll('button')) {
    const active = button.dataset.id === state.conversationId;
    button.classList.toggle('active', active);
    if (active) el.title.textContent = button.textContent;
  }
}

function setSidebarOpen(open) {
  el.app.classList.toggle('sidebar-open', open);
}

// ---------- Navigation ----------

function stopAnswer() {
  state.inflight?.abort();
}

function newChat() {
  stopAnswer();
  state.conversationId = crypto.randomUUID();
  history.replaceState(null, '', location.pathname);
  el.title.textContent = 'New chat';
  clearMessages();
  setStatus(null);
  markActive();
  setSidebarOpen(false);
  el.input.focus();
}

async function openConversation(id) {
  stopAnswer();
  setSidebarOpen(false);
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
  if (!response.ok) return newChat();
  const { conversation, messages } = await response.json();
  state.conversationId = conversation.id;
  history.replaceState(null, '', `#${conversation.id}`);
  el.title.textContent = conversation.title;
  clearMessages();
  for (const message of messages) addMessage(message.role, message.content, message.sources);
  el.messages.scrollTop = el.messages.scrollHeight;
  markActive();
}

// ---------- Streaming ----------

async function* readEvents(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
  }
}

function setBusy(busy) {
  el.send.textContent = busy ? 'Stop' : 'Send';
  el.send.classList.toggle('stop', busy);
}

async function sendMessage(text) {
  const conversationId = state.conversationId;
  const controller = new AbortController();
  state.inflight = controller;
  setBusy(true);

  addMessage('user', text);
  const answer = addMessage('assistant');
  answer.wrap.classList.add('pending');
  keepScrolled(true);
  setStatus('Sending…');

  let markdown = '';
  let sources = [];
  // Re-rendering markdown on every token is wasteful; once per frame is enough.
  let frame = 0;
  const flush = () => {
    frame = 0;
    const follow = isNearBottom();
    renderMarkdown(answer.body, markdown, sources);
    keepScrolled(follow);
  };

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, message: text, timeZone }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Request failed (${response.status})`);
    }
    if (!location.hash) history.replaceState(null, '', `#${conversationId}`);
    loadConversations();

    for await (const event of readEvents(response)) {
      switch (event.type) {
        case 'status':
          setStatus(event.text);
          break;
        case 'token':
          // The text itself now shows progress; a later search brings it back.
          setStatus(null);
          answer.wrap.classList.remove('pending');
          markdown += event.text;
          frame ||= requestAnimationFrame(flush);
          break;
        case 'sources':
          sources = event.sources;
          renderSources(answer.wrap, sources);
          frame ||= requestAnimationFrame(flush);
          break;
        case 'done':
          setStatus(null);
          break;
        case 'error':
          addNote(answer.wrap, event.message, 'error');
          break;
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') addNote(answer.wrap, 'Stopped.', 'muted');
    else addNote(answer.wrap, error.message || 'Could not reach the server.', 'error');
  } finally {
    cancelAnimationFrame(frame);
    // A conversation switch aborts this stream; don't paint into the new view.
    if (state.conversationId === conversationId) {
      flush();
      answer.wrap.classList.remove('pending');
      setStatus(null);
    }
    if (state.inflight === controller) {
      state.inflight = null;
      setBusy(false);
    }
  }
}

// ---------- Composer ----------

function autosize() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 200)}px`;
}

el.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.inflight) return stopAnswer();
  const text = el.input.value.trim();
  if (!text) return;
  el.input.value = '';
  autosize();
  sendMessage(text);
});

el.input.addEventListener('input', autosize);
el.input.addEventListener('keydown', (event) => {
  // Enter sends, Shift+Enter adds a line; never send mid-IME composition.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    el.composer.requestSubmit();
  }
});

el.newChat.addEventListener('click', newChat);
el.toggleSidebar.addEventListener('click', () => setSidebarOpen(!el.app.classList.contains('sidebar-open')));
el.scrim.addEventListener('click', () => setSidebarOpen(false));

// ---------- Boot ----------

await loadConversations();
const linked = location.hash.slice(1);
if (linked) await openConversation(linked);
