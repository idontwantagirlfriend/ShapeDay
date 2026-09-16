/**
 * i18n — enum-keyed message catalog for en-us / zh-hans / zh-hant.
 *
 * Design:
 *   - Keys are stable enums (tabs.plan, toast.done…); prose never appears
 *     at call sites, so wording changes can't break the mapping layer.
 *   - Values are templates with {placeholder} substitution, so dynamic
 *     text ("AI adjusted {n} estimate(s)") localizes as one sentence with
 *     natural word order per language.
 *   - en is the source of truth; a locale may omit an entry and falls back
 *     to en, then to the raw key (a visible sentinel, never a crash).
 *   - tests assert every locale covers the full en key set, so catalogs
 *     cannot drift apart.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.I18N = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const en = {
    // shell
    'tabs.plan': 'Plan', 'tabs.viz': 'Visualize', 'tabs.sum': 'Summarize',
    // plan
    'plan.input_ph': "What's due today?", 'plan.add_title': 'List it',
    'plan.empty': "List what's due. Everything starts red — click as you go.",
    'plan.reset': 'Reset statuses', 'plan.clear': 'Clear the day',
    'plan.auto': 'Auto-advance',
    'plan.hint.red': 'click → make current', 'plan.hint.yellow_auto': 'current · click → finish',
    'plan.hint.yellow': 'click → finish', 'plan.hint.paused': 'on break · click → resume',
    'plan.hint.green': 'click → reopen', 'plan.hint.white': 'click → revive (unfinished)',
    'plan.paused_stamp': '⏸ on break · {dur} so far',
    // eta banner
    'eta.banner': 'Review ETAs.', 'eta.ok': 'Looks right', 'eta.refine': 'Refine with AI',
    'eta.mode_smart': 'smart reading', 'eta.mode_ai': 'AI estimation',
    'eta.mode_ai_fallback': 'AI estimation (no endpoint — smart reading)',
    'eta.mode_ai_model': 'AI estimation · {model}',
    'eta.ai_adjusted': 'AI adjusted {n} estimate(s) — review again',
    'eta.unreachable': 'AI unreachable ({where}): {error}',
    'eta.nothing_to_refine': 'nothing to refine: every task is done, hung, or hand-edited',
    // reflog
    'reflog.title': 'Reflog', 'reflog.always_open': 'always open',
    'reflog.added': 'added', 'reflog.deleted': 'deleted',
    'status.red': 'red', 'status.yellow': 'yellow', 'status.green': 'green',
    'status.white': 'hung', 'status.paused': 'paused',
    // settings
    'set.work_start': 'Work start', 'set.work_end': 'Work end', 'set.break_len': 'Break length',
    'set.auto': 'Auto-advance', 'set.overlay': 'Overlay', 'set.opacity': 'Overlay opacity',
    'set.style': 'Overlay style', 'set.tint': 'Tint strength', 'set.background': 'Background',
    'set.language': 'Language', 'set.eta_mode': 'ETA estimation', 'set.sum_mode': 'Summarize mode',
    'set.template': 'Summary template', 'set.base_url': 'Base URL', 'set.api_key': 'API key',
    'set.model': 'Model', 'set.test': 'Test',
    'opt.top': 'Top bar', 'opt.floater': 'Floater',
    'opt.smart': 'Smart reading', 'opt.ai_est': 'AI estimation', 'opt.template': 'Templated text',
    // visualize
    'viz.day': 'Day', 'viz.week': 'Week', 'viz.month': 'Month', 'viz.year': 'Year',
    'viz.legend.work': 'working (broken line)', 'viz.legend.flat': 'break / idle (flat)',
    'viz.legend.pace': 'plan pace', 'viz.legend.node': 'done node', 'viz.legend.tint': 'overwork tint',
    'viz.stats.done': 'tasks done', 'viz.stats.est': 'planned vs delivered',
    'viz.stats.breaks': 'breaks taken', 'viz.stats.ow': 'overwork',
    'viz.week_summary': 'Week summary', 'viz.no_summary': 'no summary',
    'viz.no_week_summary': 'no weekly summary yet',
    'dow.1': 'Mon', 'dow.2': 'Tue', 'dow.3': 'Wed', 'dow.4': 'Thu', 'dow.5': 'Fri', 'dow.6': 'Sat', 'dow.0': 'Sun',
    // summarize
    'sum.resummarize': 'Re-summarize',
    'sum.src.error': 'AI error: {err}', 'sum.src.model': 'AI · {model}',
    'sum.src.thinking': 'AI thinking…', 'sum.src.template': 'templated text · findings from local rules',
    'sum.col.task': 'task', 'sum.col.status': 'status', 'sum.col.est': 'est', 'sum.col.actual': 'actual', 'sum.col.finished': 'finished',
    'metric.days': 'days tracked', 'metric.done': 'tasks done', 'metric.hung': 'hung',
    'metric.planned': 'planned', 'metric.actual': 'actual work', 'metric.bias': 'est. bias',
    'metric.ow_days': 'overwork days', 'metric.ow': 'overwork', 'metric.breaks': 'breaks',
    'metric.break_time': 'break time', 'metric.stretch': 'longest stretch',
    // toast
    'toast.done': 'Task done.', 'toast.on_break': 'On break',
    'toast.take_a': 'Take a', 'toast.min_break': '-min break',
    'toast.skip': 'Skip — keep going', 'toast.back': 'Back to work',
    'toast.next_up': 'Next up: {title}.', 'toast.faster': 'Ten minutes off makes the next one faster.',
    'toast.nothing': 'Nothing queued. Ten minutes off anyway?',
    'toast.look_away': 'Look away from the screen. Really.',
    // halfway notice
    'eval.half': 'Halfway', 'eval.title': 'Half of “{title}”',
    'eval.text': '{worked}m in on a {est}m task — how’s the pace?',
    'eval.ahead': 'Ahead', 'eval.on_track': 'On track', 'eval.behind': 'Behind',
    'eval.hooray': 'Hooray.', 'eval.keep': 'Keep it up.', 'eval.extend': 'Extend the ETA.',
    // bar
    'bar.no_task': 'no task on', 'bar.on_break': 'on break', 'bar.left': 'left', 'bar.left_pace': '{t} left',
    'bar.overwork': 'overwork {t}', 'bar.hours_left': '{t} of work hours left',
  };

  const zhHans = {
    'tabs.plan': '计划', 'tabs.viz': '可视化', 'tabs.sum': '总结',
    'plan.input_ph': '今天要做什么？', 'plan.add_title': '记下来',
    'plan.empty': '列出今天要做的。全部从未完成开始——边做边点。',
    'plan.reset': '重置状态', 'plan.clear': '清空今天', 'plan.auto': '自动推进',
    'plan.hint.red': '点击 → 开始', 'plan.hint.yellow_auto': '进行中 · 点击 → 完成',
    'plan.hint.yellow': '点击 → 完成', 'plan.hint.paused': '暂停 · 点击 → 继续',
    'plan.hint.green': '点击 → 重新打开', 'plan.hint.white': '点击 → 恢复为未完成',
    'plan.paused_stamp': '⏸ 休息中 · {dur} 已进行',
    'eta.banner': '核对预计用时。', 'eta.ok': '没问题', 'eta.refine': '让 AI 重新估计',
    'eta.mode_smart': '智能估时', 'eta.mode_ai': 'AI 估计',
    'eta.mode_ai_fallback': 'AI 估计（未配置接口——智能估时）',
    'eta.mode_ai_model': 'AI 估计 · {model}',
    'eta.ai_adjusted': 'AI 调整了 {n} 项预计，请再核对',
    'eta.unreachable': 'AI 不可达（{where}）：{error}',
    'eta.nothing_to_refine': '无可估计项：任务都已完成、挂起或手动改过',
    'reflog.title': '日志', 'reflog.always_open': '默认展开',
    'reflog.added': '新增', 'reflog.deleted': '删除',
    'status.red': '红', 'status.yellow': '黄', 'status.green': '绿',
    'status.white': '挂起', 'status.paused': '暂停',
    'set.work_start': '上班时间', 'set.work_end': '下班时间', 'set.break_len': '休息时长',
    'set.auto': '自动推进', 'set.overlay': '悬浮层', 'set.opacity': '悬浮层不透明度',
    'set.style': '悬浮层样式', 'set.tint': '屏幕染色强度', 'set.background': '背景',
    'set.language': '语言', 'set.eta_mode': '预计用时', 'set.sum_mode': '总结方式',
    'set.template': '总结模板', 'set.base_url': '接口地址', 'set.api_key': '密钥',
    'set.model': '模型', 'set.test': '测试',
    'opt.top': '顶栏', 'opt.floater': '悬浮胶囊',
    'opt.smart': '智能估时', 'opt.ai_est': 'AI 估计', 'opt.template': '模板文本',
    'viz.day': '日', 'viz.week': '周', 'viz.month': '月', 'viz.year': '年',
    'viz.legend.work': '工作中（虚线）', 'viz.legend.flat': '休息/空闲（平线）',
    'viz.legend.pace': '计划节奏', 'viz.legend.node': '完成节点', 'viz.legend.tint': '超时染色',
    'viz.stats.done': '完成任务', 'viz.stats.est': '计划 vs 已完成',
    'viz.stats.breaks': '休息次数', 'viz.stats.ow': '超时',
    'viz.week_summary': '周总结', 'viz.no_summary': '暂无总结', 'viz.no_week_summary': '暂无周总结',
    'dow.1': '周一', 'dow.2': '周二', 'dow.3': '周三', 'dow.4': '周四', 'dow.5': '周五', 'dow.6': '周六', 'dow.0': '周日',
    'sum.resummarize': '重新总结',
    'sum.src.error': 'AI 出错：{err}', 'sum.src.model': 'AI · {model}',
    'sum.src.thinking': 'AI 思考中…', 'sum.src.template': '模板文本 · 本地规则产出',
    'sum.col.task': '任务', 'sum.col.status': '状态', 'sum.col.est': '预计', 'sum.col.actual': '实际', 'sum.col.finished': '完成时间',
    'metric.days': '记录天数', 'metric.done': '完成任务', 'metric.hung': '挂起',
    'metric.planned': '计划', 'metric.actual': '实际工作', 'metric.bias': '估计偏差',
    'metric.ow_days': '超时天数', 'metric.ow': '超时', 'metric.breaks': '休息次数',
    'metric.break_time': '休息时长', 'metric.stretch': '最长连续',
    'toast.done': '任务完成。', 'toast.on_break': '休息中',
    'toast.take_a': '休息', 'toast.min_break': '分钟',
    'toast.skip': '跳过，继续工作', 'toast.back': '回到工作',
    'toast.next_up': '接下来：{title}。', 'toast.faster': '休息十分钟，下一个更快。',
    'toast.nothing': '没有排队的任务，还是休息十分钟？',
    'toast.look_away': '离开屏幕看看远处。认真的。',
    'eval.half': '过半了', 'eval.title': '“{title}”过半',
    'eval.text': '已用 {worked}m / 预计 {est}m——节奏如何？',
    'eval.ahead': '领先', 'eval.on_track': '正常', 'eval.behind': '落后',
    'eval.hooray': '好样的。', 'eval.keep': '保持住。', 'eval.extend': '延长预计用时。',
    'bar.no_task': '没有进行中的任务', 'bar.on_break': '休息中', 'bar.left': '剩余', 'bar.left_pace': '剩余 {t}',
    'bar.overwork': '超时 {t}', 'bar.hours_left': '工作时间内剩余 {t}',
  };

  const zhHant = {
    'tabs.plan': '計劃', 'tabs.viz': '可視化', 'tabs.sum': '總結',
    'plan.input_ph': '今天要做什麼？', 'plan.add_title': '記下來',
    'plan.empty': '列出今天要做的。全部從未完成開始——邊做邊點。',
    'plan.reset': '重置狀態', 'plan.clear': '清空今天', 'plan.auto': '自動推進',
    'plan.hint.red': '點擊 → 開始', 'plan.hint.yellow_auto': '進行中 · 點擊 → 完成',
    'plan.hint.yellow': '點擊 → 完成', 'plan.hint.paused': '暫停 · 點擊 → 繼續',
    'plan.hint.green': '點擊 → 重新打開', 'plan.hint.white': '點擊 → 恢復為未完成',
    'plan.paused_stamp': '⏸ 休息中 · {dur} 已進行',
    'eta.banner': '核對預計用時。', 'eta.ok': '沒問題', 'eta.refine': '讓 AI 重新估計',
    'eta.mode_smart': '智能估時', 'eta.mode_ai': 'AI 估計',
    'eta.mode_ai_fallback': 'AI 估計（未配置接口——智能估時）',
    'eta.mode_ai_model': 'AI 估計 · {model}',
    'eta.ai_adjusted': 'AI 調整了 {n} 項預計，請再核對',
    'eta.unreachable': 'AI 不可達（{where}）：{error}',
    'eta.nothing_to_refine': '無可估計項：任務都已完成、掛起或手動改過',
    'reflog.title': '日誌', 'reflog.always_open': '默認展開',
    'reflog.added': '新增', 'reflog.deleted': '刪除',
    'status.red': '紅', 'status.yellow': '黃', 'status.green': '綠',
    'status.white': '掛起', 'status.paused': '暫停',
    'set.work_start': '上班時間', 'set.work_end': '下班時間', 'set.break_len': '休息時長',
    'set.auto': '自動推進', 'set.overlay': '懸浮層', 'set.opacity': '懸浮層不透明度',
    'set.style': '懸浮層樣式', 'set.tint': '屏幕染色強度', 'set.background': '背景',
    'set.language': '語言', 'set.eta_mode': '預計用時', 'set.sum_mode': '總結方式',
    'set.template': '總結模板', 'set.base_url': '接口地址', 'set.api_key': '密鑰',
    'set.model': '模型', 'set.test': '測試',
    'opt.top': '頂欄', 'opt.floater': '懸浮膠囊',
    'opt.smart': '智能估時', 'opt.ai_est': 'AI 估計', 'opt.template': '模板文本',
    'viz.day': '日', 'viz.week': '週', 'viz.month': '月', 'viz.year': '年',
    'viz.legend.work': '工作中（虛線）', 'viz.legend.flat': '休息/空閒（平線）',
    'viz.legend.pace': '計劃節奏', 'viz.legend.node': '完成節點', 'viz.legend.tint': '超時染色',
    'viz.stats.done': '完成任務', 'viz.stats.est': '計劃 vs 已完成',
    'viz.stats.breaks': '休息次數', 'viz.stats.ow': '超時',
    'viz.week_summary': '週總結', 'viz.no_summary': '暫無總結', 'viz.no_week_summary': '暫無週總結',
    'dow.1': '週一', 'dow.2': '週二', 'dow.3': '週三', 'dow.4': '週四', 'dow.5': '週五', 'dow.6': '週六', 'dow.0': '週日',
    'sum.resummarize': '重新總結',
    'sum.src.error': 'AI 出錯：{err}', 'sum.src.model': 'AI · {model}',
    'sum.src.thinking': 'AI 思考中…', 'sum.src.template': '模板文本 · 本地規則產出',
    'sum.col.task': '任務', 'sum.col.status': '狀態', 'sum.col.est': '預計', 'sum.col.actual': '實際', 'sum.col.finished': '完成時間',
    'metric.days': '記錄天數', 'metric.done': '完成任務', 'metric.hung': '掛起',
    'metric.planned': '計劃', 'metric.actual': '實際工作', 'metric.bias': '估計偏差',
    'metric.ow_days': '超時天數', 'metric.ow': '超時', 'metric.breaks': '休息次數',
    'metric.break_time': '休息時長', 'metric.stretch': '最長連續',
    'toast.done': '任務完成。', 'toast.on_break': '休息中',
    'toast.take_a': '休息', 'toast.min_break': '分鐘',
    'toast.skip': '跳過，繼續工作', 'toast.back': '回到工作',
    'toast.next_up': '接下來：{title}。', 'toast.faster': '休息十分鐘，下一個更快。',
    'toast.nothing': '沒有排隊的任務，還是休息十分鐘？',
    'toast.look_away': '離開屏幕看看遠處。認真的。',
    'eval.half': '過半了', 'eval.title': '“{title}”過半',
    'eval.text': '已用 {worked}m / 預計 {est}m——節奏如何？',
    'eval.ahead': '領先', 'eval.on_track': '正常', 'eval.behind': '落後',
    'eval.hooray': '好樣的。', 'eval.keep': '保持住。', 'eval.extend': '延長預計用時。',
    'bar.no_task': '沒有進行中的任務', 'bar.on_break': '休息中', 'bar.left': '剩餘', 'bar.left_pace': '剩餘 {t}',
    'bar.overwork': '超時 {t}', 'bar.hours_left': '工作時間內剩餘 {t}',
  };

  const LOCALES = { 'en-us': en, 'zh-hans': zhHans, 'zh-hant': zhHant };

  /** Map any platform tag onto the three supported locales. */
  function resolve(pref, platformLang) {
    const raw = String(pref === 'auto' || !pref ? platformLang || '' : pref).toLowerCase();
    if (/(hant|tw|hk|mo)/.test(raw) && raw.startsWith('zh')) return 'zh-hant';
    if (raw.startsWith('zh')) return 'zh-hans';
    return 'en-us';
  }

  /** t(locale, key, params?) — template lookup with {placeholder} substitution. */
  function t(locale, key, params) {
    const dict = LOCALES[locale] || en;
    const tpl = dict[key] ?? en[key] ?? key;
    if (tpl == null || !params) return tpl ?? key;
    return String(tpl).replace(/\{(\w+)\}/g, (m, name) =>
      params[name] != null ? String(params[name]) : m
    );
  }

  return { t, resolve, LOCALES };
});
