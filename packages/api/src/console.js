/*
 * The console: three workbenches, no framework, no build step.
 *
 * It is deliberately a thin client: every panel is a table over an endpoint this repository already exposes, and
 * the buttons map one-to-one to those endpoints. A console that hides the API behind a framework is a console
 * nobody can debug; this one can be read and driven with curl, and the verification drives it the same way.
 */

const state = { lastPlanId: null, model: null };

const keyInput = document.getElementById('key');
keyInput.value = sessionStorage.getItem('pag-key') ?? '';
keyInput.addEventListener('change', () => sessionStorage.setItem('pag-key', keyInput.value));

document.querySelectorAll('nav button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((entry) => entry.classList.toggle('active', entry === button));
    document.querySelectorAll('main section').forEach((section) => section.classList.toggle('active', section.id === button.dataset.tab));
  });
});

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': keyInput.value },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { parsed = text; }
  return { ok: response.ok, status: response.status, body: parsed };
}

function show(element, value, asJson = true) {
  element.textContent = asJson ? JSON.stringify(value, null, 2) : String(value);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
}

// --- semantic review -------------------------------------------------------------------------------
const semanticOut = document.getElementById('semantic-out');
const semanticTable = document.getElementById('semantic-review');
const semanticSummary = document.getElementById('semantic-summary');

async function loadModel() {
  const result = await api('GET', '/v1/semantic/model');
  if (!result.ok) return show(semanticOut, result);
  state.model = result.body;
  semanticSummary.textContent = `${result.body.metrics.length} 指标 · ${result.body.dimensions.length} 维度 · ${result.body.relations.length} 关系 · 待审 ${result.body.needsReview.length}`;
  const rows = [...result.body.metrics, ...result.body.dimensions]
    .filter((entry) => entry.status === 'needs_review')
    .map((entry) => `<tr>
      <td><code>${escapeHtml(entry.id)}</code></td>
      <td>${escapeHtml(entry.note ?? '')}</td>
      <td>
        <button data-review="accept" data-target="${escapeHtml(entry.id)}">采纳</button>
        <button data-review="reject" data-target="${escapeHtml(entry.id)}">拒绝</button>
      </td></tr>`).join('');
  semanticTable.innerHTML = rows.length > 0
    ? `<table><thead><tr><th>候选</th><th>为什么需要人来看</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="ok">没有待审候选。</p>';
  show(semanticOut, { gate: result.body.gate ?? null, needsReview: result.body.needsReview });
  return result.body;
}

document.querySelectorAll('[data-act]').forEach((button) => {
  button.addEventListener('click', async () => {
    const action = button.dataset.act;
    if (action === 'semantic-load') return loadModel();
    if (action === 'semantic-report') {
      const result = await api('GET', '/v1/semantic/report');
      return show(semanticOut, result);
    }
    if (action === 'semantic-build') {
      const result = await api('POST', '/v1/semantic/build', {});
      show(semanticOut, result);
      return loadModel();
    }
    if (action === 'semantic-publish') {
      const result = await api('POST', '/v1/semantic/publish', {});
      return show(semanticOut, result);
    }
    if (action === 'sql-plan') {
      const sql = document.getElementById('sql-input').value;
      const required = document.getElementById('sql-required').value.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
      const result = await api('POST', '/v1/sql/plan', { sql, requiredColumns: required });
      const out = document.getElementById('sql-out');
      if (!result.ok) return show(out, result);
      state.lastPlanId = result.body.id;
      const steps = result.body.steps.map((step) => `<tr>
        <td>${step.seq}</td><td><code>${escapeHtml(step.rule)}</code> <span class="pill">${step.kind}</span></td>
        <td>${escapeHtml(step.rationale)}</td>
        <td>${step.kind === 'rewrite'
          ? `<button data-step="apply" data-seq="${step.seq}">应用</button><button data-step="revert" data-seq="${step.seq}">撤销</button>`
          : '<span class="muted">仅建议</span>'}</td></tr>`).join('');
      document.getElementById('sql-out').innerHTML = `<div class="muted">plan ${escapeHtml(result.body.id)}</div>`
        + `<table><thead><tr><th>#</th><th>规则</th><th>理由</th><th></th></tr></thead><tbody>${steps}</tbody></table>`
        + `<pre>${escapeHtml(JSON.stringify({ findings: result.body.findings, comparison: result.body.comparison }, null, 2))}</pre>`;
      return;
    }
    if (action === 'sql-state') {
      if (!state.lastPlanId) return show(document.getElementById('sql-out'), { error: '先 plan 一次' });
      return show(document.getElementById('sql-out'), await api('GET', `/v1/sql/steps/${state.lastPlanId}`));
    }
    if (action === 'skills-load') {
      const result = await api('GET', '/v1/skills');
      const list = document.getElementById('skills-list');
      if (!result.ok) return show(document.getElementById('skills-out'), result);
      list.innerHTML = `<table><thead><tr><th>tip</th><th>状态</th><th>分数</th><th>确认/退役</th></tr></thead><tbody>${result.body.tips
        .map((tip) => `<tr><td><code>${escapeHtml(tip.id)}</code><div class="muted">${escapeHtml(tip.statement)}</div></td>
          <td>${escapeHtml(tip.status)}</td><td>${tip.score}</td><td>${tip.confirmations}/${tip.misses}
          ${tip.status === 'candidate' ? `<button data-tip="${escapeHtml(tip.id)}">晋升</button>` : ''}</td></tr>`)
        .join('')}</tbody></table>`;
      return;
    }
    if (action === 'skills-advise') {
      const sql = document.getElementById('advise-sql').value;
      return show(document.getElementById('skills-out'), await api('POST', '/v1/skills/advise', { sql }));
    }
    if (action === 'skills-export') {
      const result = await api('GET', '/v1/skills/export');
      return show(document.getElementById('skills-out'), result, false);
    }
    if (action === 'ask') {
      const question = document.getElementById('ask-input').value;
      return show(document.getElementById('agents-out'), await api('POST', '/v1/ask', { question }));
    }
    if (action === 'attr') {
      const metric = document.getElementById('attr-metric').value;
      const from = document.getElementById('attr-from').value;
      const to = document.getElementById('attr-to').value;
      return show(document.getElementById('agents-out'), await api('POST', '/v1/attribute', { metric, from, to }));
    }
    if (action === 'campaign') return show(document.getElementById('agents-out'), await api('POST', '/v1/campaign/optimize', {}));
    if (action === 'risk') return show(document.getElementById('agents-out'), await api('GET', '/v1/risk/report'));
  });
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.review) {
    const result = await api('POST', '/v1/semantic/review', {
      action: button.dataset.review, target: button.dataset.target, reason: 'reviewed in the console',
    });
    show(semanticOut, result);
    return loadModel();
  }
  if (button.dataset.step) {
    const result = await api('POST', `/v1/sql/steps/${state.lastPlanId}`, {
      action: button.dataset.step, step: Number(button.dataset.seq),
    });
    return show(document.getElementById('sql-out'), result);
  }
  if (button.dataset.tip) {
    const result = await api('POST', '/v1/skills/decide', { id: button.dataset.tip, action: 'promote', note: 'promoted in the console' });
    return show(document.getElementById('skills-out'), result);
  }
});

loadModel().catch(() => {});
