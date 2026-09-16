/**
 * i18n — tiny dictionary layer for en-us / zh-hans / zh-hant.
 * English source strings are the keys; missing keys fall back to English,
 * then to the key itself. Locale resolution maps platform tags (zh-CN,
 * zh-TW, en-GB…) onto the three supported locales.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.I18N = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LOCALES = {
    'en-us': {},
    'zh-hans': {
      Plan: '计划', Visualize: '可视化', Summarize: '总结',
      "What's due today?": '今天要做什么？',
      'Review ETAs.': '核对预计用时。', 'Looks right': '没问题',
      'Refine with AI': '让 AI 重新估计',
      'smart reading': '智能估时',
      'List it': '记下来',
      'Reset statuses': '重置状态', 'Clear the day': '清空今天',
      'Auto-advance': '自动推进', 'Overlay': '悬浮层',
      'Overlay opacity': '悬浮层不透明度', 'Overlay style': '悬浮层样式',
      'Tint strength': '屏幕染色强度', 'Background': '背景',
      'Work start': '上班时间', 'Work end': '下班时间', 'Break length': '休息时长',
      'ETA estimation': '预计用时', 'Summarize': '总结方式',
      'Summary template': '总结模板', 'Base URL': '接口地址', 'API key': '密钥',
      'Model': '模型', 'Test': '测试', 'Language': '语言',
      'Top bar': '顶栏', 'Floater': '悬浮胶囊',
      'Smart reading': '智能估时', 'AI estimation': 'AI 估计',
      'Templated text': '模板文本', 'AI': 'AI',
      Day: '日', Week: '周', Month: '月', Year: '年', Today: '今天',
      'Re-summarize': '重新总结',
      'Reflog': '日志', 'always open': '默认展开',
      'Task done.': '任务完成。', 'On break': '休息中',
      'Take a': '休息', '-min break': '分钟',
      'Skip — keep going': '跳过，继续工作', 'Back to work': '回到工作',
      "Next up:": '接下来：', 'Nothing queued. Ten minutes off anyway?': '没有排队的任务，还是休息十分钟？',
      'Ten minutes off makes the next one faster.': '休息十分钟，下一个更快。',
      'Look away from the screen. Really.': '离开屏幕看看远处。认真的。',
      'Halfway': '过半了', "Half of this task is done — how's the pace?": '这个任务过半了——节奏如何？',
      Ahead: '领先', 'On track': '正常', Behind: '落后',
      'Hooray.': '好样的。', 'Keep it up.': '保持住。', 'Extend the ETA.': '延长预计用时。',
      'no task on': '没有进行中的任务', 'on break': '休息中', 'left': '剩余',
      'overwork': '超时', 'of work hours left': '工作时间内剩余',
      'red': '红', 'yellow': '黄', 'green': '绿', 'white': '挂起', 'paused': '暂停',
      'added': '新增', 'deleted': '删除', 'status': '状态',
      'tasks done': '完成任务', 'planned vs delivered': '计划 vs 已完成',
      'breaks taken': '休息次数', 'overwork': '超时',
      'no summary': '暂无总结', 'no weekly summary yet': '暂无周总结',
      'Week summary': '周总结',
      Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六', Sun: '周日',
      'List what\'s due. Everything starts red — click as you go.':
        '列出今天要做的。全部从未完成开始——边做边点。',
      'click → make current': '点击 → 开始', 'current · click → finish': '进行中 · 点击 → 完成',
      'on break · click → resume': '暂停 · 点击 → 继续', 'click → reopen': '点击 → 重新打开',
      'click → revive (unfinished)': '点击 → 恢复为未完成',
      'click → start': '点击 → 开始', 'click → finish': '点击 → 完成',
    },
    'zh-hant': {
      Plan: '計劃', Visualize: '可視化', Summarize: '總結',
      "What's due today?": '今天要做什麼？',
      'Review ETAs.': '核對預計用時。', 'Looks right': '沒問題',
      'Refine with AI': '讓 AI 重新估計',
      'smart reading': '智能估時',
      'Reset statuses': '重置狀態', 'Clear the day': '清空今天',
      'Auto-advance': '自動推進', 'Overlay': '懸浮層',
      'Overlay opacity': '懸浮層不透明度', 'Overlay style': '懸浮層樣式',
      'Tint strength': '屏幕染色強度', 'Background': '背景',
      'Work start': '上班時間', 'Work end': '下班時間', 'Break length': '休息時長',
      'ETA estimation': '預計用時', 'Summarize': '總結方式',
      'Summary template': '總結模板', 'Base URL': '接口地址', 'API key': '密鑰',
      'Model': '模型', 'Test': '測試', 'Language': '語言',
      'Top bar': '頂欄', 'Floater': '懸浮膠囊',
      'Smart reading': '智能估時', 'AI estimation': 'AI 估計',
      'Templated text': '模板文本', 'AI': 'AI',
      Day: '日', Week: '週', Month: '月', Year: '年', Today: '今天',
      'Re-summarize': '重新總結',
      'Reflog': '日誌', 'always open': '默認展開',
      'Task done.': '任務完成。', 'On break': '休息中',
      'Take a': '休息', '-min break': '分鐘',
      'Skip — keep going': '跳過，繼續工作', 'Back to work': '回到工作',
      "Next up:": '接下來：', 'Nothing queued. Ten minutes off anyway?': '沒有排隊的任務，還是休息十分鐘？',
      'Ten minutes off makes the next one faster.': '休息十分鐘，下一個更快。',
      'Look away from the screen. Really.': '離開屏幕看看遠處。認真的。',
      'Halfway': '過半了', "Half of this task is done — how's the pace?": '這個任務過半了——節奏如何？',
      Ahead: '領先', 'On track': '正常', Behind: '落後',
      'Hooray.': '好樣的。', 'Keep it up.': '保持住。', 'Extend the ETA.': '延長預計用時。',
      'no task on': '沒有進行中的任務', 'on break': '休息中', 'left': '剩餘',
      'overwork': '超時', 'of work hours left': '工作時間內剩餘',
      'red': '紅', 'yellow': '黃', 'green': '綠', 'white': '掛起', 'paused': '暫停',
      'added': '新增', 'deleted': '刪除', 'status': '狀態',
      'tasks done': '完成任務', 'planned vs delivered': '計劃 vs 已完成',
      'breaks taken': '休息次數',
      'no summary': '暫無總結', 'no weekly summary yet': '暫無週總結',
      'Week summary': '週總結',
      Mon: '週一', Tue: '週二', Wed: '週三', Thu: '週四', Fri: '週五', Sat: '週六', Sun: '週日',
      'List what\'s due. Everything starts red — click as you go.':
        '列出今天要做的。全部從未完成開始——邊做邊點。',
      'click → make current': '點擊 → 開始', 'current · click → finish': '進行中 · 點擊 → 完成',
      'on break · click → resume': '暫停 · 點擊 → 繼續', 'click → reopen': '點擊 → 重新打開',
      'click → revive (unfinished)': '點擊 → 恢復為未完成',
      'click → start': '點擊 → 開始', 'click → finish': '點擊 → 完成',
    },
  };

  /** Map any platform tag onto the three supported locales. */
  function resolve(pref, platformLang) {
    const raw = String(pref === 'auto' || !pref ? platformLang || '' : pref).toLowerCase();
    if (/^zh.*(hant|tw|hk|mo)|^zh[-_]?(tw|hk|mo)/.test(raw) || /tw|hk|mo|hant/.test(raw) && raw.startsWith('zh')) return 'zh-hant';
    if (raw.startsWith('zh')) return 'zh-hans';
    if (raw.startsWith('en')) return 'en-us';
    return 'en-us';
  }

  function t(locale, key) {
    const dict = LOCALES[locale] || LOCALES['en-us'];
    return dict[key] ?? LOCALES['en-us'][key] ?? key;
  }

  return { t, resolve, LOCALES };
});
