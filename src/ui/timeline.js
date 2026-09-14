/**
 * Timeline — "the shape of the day".
 *
 * Reading of PROJECT.md Phase Two:
 *   x = wall clock across the work hours; y = planned minutes delivered.
 *   Each task connects its start & end nodes with a broken (dashed) line;
 *   breaks and parked time flatten the line (nothing is delivered);
 *   the ideal line spreads the workload evenly over the work hours;
 *   the area beneath the line past work-end is the overwork region, tinted
 *   per the spec's escalating colors (#aed8fc → #db9696 → #803d3a).
 *
 * In-progress tasks rise 1:1 with worked minutes (capped at their estimate);
 * a dotted projection shows where the current pace lands.
 */
(function () {
  'use strict';
  const MIN = 60000;

  let state = { chart: null, hover: null, tip: null, cursor: null };

  /** Cumulative earned series across all started tasks. */
  function build(day, bounds, now) {
    const tasks = (day.tasks || [])
      .filter((t) => (t.worked || []).length > 0)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

    const totalEst = (day.tasks || [])
      .filter((t) => t.status !== 'white')
      .reduce((s, t) => s + t.estimateMin, 0);

    let cursorY = 0;
    const segs = [];
    const nodes = [];
    let maxX = bounds.end;

    for (const t of tasks) {
      const worked = (t.worked || []).map((s) => ({
        start: s.start,
        end: Math.min(s.end ?? now, now),
      }));
      const totalWorked = worked.reduce((s, x) => s + (x.end - x.start), 0) / MIN;
      if (totalWorked <= 0) continue;

      const riseTotal =
        t.status === 'green' ? t.estimateMin : Math.min(totalWorked, t.estimateMin);

      nodes.push({ x: worked[0].start, y: cursorY, title: t.title, kind: 'start', task: t });

      for (const w of worked) {
        const rise = riseTotal * ((w.end - w.start) / MIN) / totalWorked;
        if (rise > 0.0001) segs.push({ x0: w.start, x1: w.end, y0: cursorY, y1: cursorY + rise, kind: 'work', task: t });
        else segs.push({ x0: w.start, x1: w.end, y0: cursorY, y1: cursorY, kind: 'flat', task: t });
        cursorY += rise;
        maxX = Math.max(maxX, w.end);
      }

      const endX = t.finishedAt ?? Math.min(now, worked[worked.length - 1].end);
      nodes.push({ x: endX, y: cursorY, title: t.title, kind: t.status === 'green' ? 'done' : 'current', task: t });
      maxX = Math.max(maxX, endX);

      if (t.status === 'yellow') {
        // Projection: the earned-so-far is riseTotal; carry the rest at 1:1 pace.
        const remaining = Math.max(0, t.estimateMin - riseTotal);
        segs.push({ x0: now, x1: now + remaining * MIN, y0: cursorY, y1: cursorY + remaining, kind: 'projected', task: t });
        maxX = Math.max(maxX, now + remaining * MIN);
      }
    }

    // Flat markers for breaks (the line flats on them; draw as labeled ledges).
    const breakMarks = (day.breaks || []).map((b) => ({
      x0: b.start,
      x1: Math.min(b.end ?? now, now),
      plannedMin: b.plannedMin || 10,
    }));
    maxX = Math.max(maxX, now, ...breakMarks.map((b) => b.x1));

    const x0 = bounds.start;
    const x1 = maxX + 6 * MIN;
    const yMax = Math.max(totalEst, cursorY, 30);

    return {
      segs, nodes, breakMarks, totalEst,
      ideal: { x0: bounds.start, x1: bounds.end, y1: totalEst },
      domain: { x0, x1, y0: 0, y1: Math.ceil((yMax * 1.12) / 30) * 30 },
      bounds, now, cursorY,
    };
  }

  function draw(canvas) {
    const chart = state.chart;
    if (!chart) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 900;
    const H = canvas.height / (canvas._dpr || 1) || 380;
    canvas._dpr = dpr;
    if (canvas.width !== Math.round(W * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const D = chart.domain;
    const padL = 46, padR = 14, padT = 18, padB = 30;
    const iw = W - padL - padR, ih = H - padT - padB;
    const X = (t) => padL + ((t - D.x0) / (D.x1 - D.x0)) * iw;
    const Y = (v) => padT + ih - (v / D.y1) * ih;

    // ---- grid ----
    ctx.font = '11px system-ui';
    ctx.textBaseline = 'middle';
    const hourStep = Math.max(1, Math.round((D.x1 - D.x0) / MIN / 10));
    for (let t = D.x0; t <= D.x1; t += hourStep * 3600000) {
      const x = X(t);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ih); ctx.stroke();
      ctx.fillStyle = '#9aa1ad';
      const d = new Date(t);
      ctx.textAlign = 'center';
      ctx.fillText(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, x, padT + ih + 14);
    }
    ctx.textAlign = 'right';
    for (let v = 0; v <= D.y1; v += 60) {
      const y = Y(v);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillStyle = '#9aa1ad';
      ctx.fillText(`${v}m`, padL - 8, y);
    }

    // ---- overwork region: tinted area beneath the curve ----
    const owStart = chart.bounds.end;
    if (D.x1 > owStart) {
      const stops = Overwork.gradientStops();
      const g = ctx.createLinearGradient(X(owStart), 0, X(Math.min(D.x1, owStart + 150 * MIN)), 0);
      for (const s of stops) {
        g.addColorStop(Math.min(1, s.at / 150), s.color + '55');
      }
      ctx.fillStyle = g;
      ctx.fillRect(X(owStart), padT, X(D.x1) - X(owStart), ih);
    }

    // ---- under-curve fill (earned area) ----
    ctx.beginPath();
    ctx.moveTo(X(D.x0), Y(0));
    let cy = 0;
    for (const s of chart.segs.filter((s) => s.kind !== 'projected')) {
      if (s.y0 !== cy) ctx.lineTo(X(s.x0), Y(cy));
      ctx.lineTo(X(s.x0), Y(s.y0));
      ctx.lineTo(X(s.x1), Y(s.y1));
      cy = s.y1;
    }
    ctx.lineTo(X(D.x1), Y(cy));
    ctx.lineTo(X(D.x1), Y(0));
    ctx.closePath();
    const areaG = ctx.createLinearGradient(0, padT, 0, padT + ih);
    areaG.addColorStop(0, 'rgba(174, 216, 252, 0.16)');
    areaG.addColorStop(1, 'rgba(174, 216, 252, 0.03)');
    ctx.fillStyle = areaG;
    ctx.fill();

    // ---- ideal line: workload spread over work hours ----
    ctx.save();
    ctx.strokeStyle = 'rgba(232, 230, 227, 0.35)';
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(X(chart.ideal.x0), Y(0));
    ctx.lineTo(X(chart.ideal.x1), Y(chart.ideal.y1));
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(232, 230, 227, 0.5)';
    ctx.textAlign = 'left';
    ctx.fillText('plan', X(chart.ideal.x1) - 26, Y(chart.ideal.y1) - 10);

    // ---- the line: broken where working, flat where not ----
    for (const s of chart.segs) {
      ctx.beginPath();
      ctx.moveTo(X(s.x0), Y(s.y0));
      ctx.lineTo(X(s.x1), Y(s.y1));
      if (s.kind === 'work') {
        ctx.strokeStyle = '#aed8fc';
        ctx.lineWidth = 2.2;
        ctx.setLineDash([7, 5]); // the broken line
      } else if (s.kind === 'flat') {
        ctx.strokeStyle = 'rgba(216, 216, 216, 0.5)';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = 'rgba(217, 164, 65, 0.75)';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([2, 4]); // projection
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // ---- break ledges ----
    for (const b of chart.breakMarks) {
      if (b.x1 <= b.x0) continue;
      ctx.fillStyle = 'rgba(154, 161, 173, 0.6)';
      ctx.fillRect(X(b.x0), padT + ih + 2, Math.max(2, X(b.x1) - X(b.x0)), 3);
    }

    // ---- start/end nodes ----
    for (const n of chart.nodes) {
      const r = n.kind === 'current' ? 5 : 4;
      ctx.beginPath();
      ctx.arc(X(n.x), Y(n.y), r, 0, Math.PI * 2);
      ctx.fillStyle = n.kind === 'done' ? '#61b361' : n.kind === 'current' ? '#d9a441' : '#16181d';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = n.kind === 'start' ? '#aed8fc' : n.kind === 'done' ? '#61b361' : '#d9a441';
      ctx.stroke();
    }

    // ---- work-end boundary ----
    if (D.x1 > owStart || chart.now >= owStart) {
      const x = X(owStart);
      ctx.strokeStyle = 'rgba(224, 101, 90, 0.6)';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ih); ctx.stroke();
      ctx.fillStyle = 'rgba(224, 101, 90, 0.9)';
      ctx.textAlign = 'left';
      const d = new Date(owStart);
      ctx.fillText(
        `hours end ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
        x + 6, padT + 8
      );
    }

    // ---- now cursor ----
    if (chart.now >= D.x0 && chart.now <= D.x1) {
      const x = X(chart.now);
      ctx.strokeStyle = 'rgba(232, 230, 227, 0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ih); ctx.stroke();
    }

    // ---- hover crosshair: progress at time X ----
    if (state.cursor && !state.tip) {
      const t = state.cursor;
      const { y, task } = progressAt(chart, t);
      const x = X(t);
      ctx.strokeStyle = 'rgba(174, 216, 252, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ih); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(x, Y(y), 4, 0, Math.PI * 2);
      ctx.fillStyle = '#aed8fc';
      ctx.fill();
      ctx.strokeStyle = '#16181d';
      ctx.lineWidth = 2;
      ctx.stroke();
      const ht = new Date(t);
      const label =
        `${String(ht.getHours()).padStart(2, '0')}:${String(ht.getMinutes()).padStart(2, '0')} · ` +
        `${Math.round(y)}m done` +
        (task ? ` · ${task.title.length > 26 ? task.title.slice(0, 25) + '…' : task.title}` : '');
      ctx.font = '12px system-ui';
      const w = ctx.measureText(label).width + 16;
      const tx = Math.min(Math.max(x - w / 2, padL), W - padR - w);
      const ty = padT + 6;
      ctx.fillStyle = 'rgba(30, 33, 40, 0.97)';
      ctx.strokeStyle = '#2c313c';
      ctx.beginPath();
      ctx.roundRect(tx, ty, w, 22, 6);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e8e6e3';
      ctx.textAlign = 'left';
      ctx.fillText(label, tx + 8, ty + 11);
    }

    // ---- hover tooltip ----
    if (state.tip) {
      const t = state.tip;
      const label = t.kind === 'start' ? `start · ${t.title}` : t.kind === 'done' ? `done · ${t.title}` : `now · ${t.title}`;
      ctx.font = '12px system-ui';
      const w = ctx.measureText(label).width + 16;
      let tx = Math.min(Math.max(X(t.x) - w / 2, padL), W - padR - w);
      const ty = Y(t.y) - 30;
      ctx.fillStyle = 'rgba(30, 33, 40, 0.97)';
      ctx.strokeStyle = '#2c313c';
      ctx.beginPath();
      ctx.roundRect(tx, ty, w, 22, 6);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e8e6e3';
      ctx.textAlign = 'left';
      ctx.fillText(label, tx + 8, ty + 11);
    }

    canvas._geom = { X, Y, padL, padR, padT, padB, W, H };
  }

  function render(canvas, day, bounds, now) {
    state.chart = build(day, bounds, now);
    state.canvas = canvas;
    draw(canvas);
  }

  /** Delivered minutes at wall-clock time t: walk the segments, partial-rise the one under t. */
  function progressAt(chart, t) {
    let y = 0, task = null;
    for (const s of chart.segs) {
      if (s.kind === 'projected') continue;
      if (t >= s.x1) {
        y += s.y1 - s.y0;
      } else if (t > s.x0) {
        const k = (t - s.x0) / (s.x1 - s.x0 || 1);
        y += (s.y1 - s.y0) * k;
        if (s.kind === 'work') task = s.task;
      }
    }
    return { y, task };
  }

  function hover(canvas, clientX, clientY) {
    const chart = state.chart;
    const geom = canvas._geom;
    if (!chart || !geom) return;
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    let best = null, bestD = 12 * 12;
    for (const n of chart.nodes) {
      const dx = geom.X(n.x) - mx, dy = geom.Y(n.y) - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = n; }
    }
    const inside = mx >= geom.padL && mx <= geom.W - geom.padR && my >= geom.padT && my <= geom.H - geom.padB;
    if (inside) {
      const D = chart.domain;
      const iw = geom.W - geom.padL - geom.padR;
      state.cursor = Math.max(D.x0, Math.min(D.x1, D.x0 + ((mx - geom.padL) / iw) * (D.x1 - D.x0)));
    } else {
      state.cursor = null;
    }
    state.tip = best;
    draw(canvas);
    canvas.style.cursor = best ? 'pointer' : 'default';
  }

  function hoverEnd() {
    state.cursor = null;
    state.tip = null;
    if (state.canvas) draw(state.canvas);
  }

  // ---------- week / month grids ----------
  // overwork threshold for the calendar views: a day counts as overworked
  // from 30 minutes past its work end (PROJECT.md's first tint boundary)
  const OVERWORK_THRESHOLD_MIN = 30;

  function keyOf(d) {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function prepCanvas(canvas, h = 380) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 900;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, W, H: h };
  }

  /** Fill color for a task block by status. */
  function taskFill(status) {
    return {
      green: 'rgba(97, 179, 97, 0.75)',
      yellow: 'rgba(217, 164, 65, 0.8)',
      paused: 'rgba(174, 216, 252, 0.55)',
      red: 'rgba(224, 101, 90, 0.28)',
      white: 'rgba(216, 216, 216, 0.18)',
    }[status] || 'rgba(255, 255, 255, 0.1)';
  }

  function renderWeek(canvas, data) {
    const { ctx, W, H } = prepCanvas(canvas);
    ctx.clearRect(0, 0, W, H);
    const byKey = new Map(data.days.map((d) => [d.date, d]));
    const dates = [];
    const cur = new Date(data.fromKey + 'T00:00:00');
    while (keyOf(cur) <= data.toKey) {
      dates.push(keyOf(cur));
      cur.setDate(cur.getDate() + 1);
    }

    // shared time-of-day domain (minutes from midnight)
    let m0 = Infinity, m1 = -Infinity;
    for (const d of data.days) {
      const start = (d.workStart - new Date(d.date + 'T00:00:00').getTime()) / 60000;
      const end = (d.workEnd - new Date(d.date + 'T00:00:00').getTime()) / 60000;
      m0 = Math.min(m0, start);
      m1 = Math.max(m1, end + d.overworkMin);
    }
    if (!isFinite(m0)) { m0 = 8 * 60; m1 = 18 * 60; }
    m0 = Math.max(0, m0 - 30);
    m1 += 30;

    const padT = 34, padB = 10;
    const colW = W / dates.length;
    const plotH = H - padT - padB;
    const yOf = (m) => padT + ((m - m0) / (m1 - m0)) * plotH;
    const scale = plotH / (m1 - m0);

    ctx.font = '11px system-ui';
    ctx.textBaseline = 'top';
    dates.forEach((date, i) => {
      const x = i * colW;
      const d = byKey.get(date);
      const dayNum = Number(date.slice(8));
      const isToday = date === data.todayKey;

      // header
      ctx.fillStyle = isToday ? '#aed8fc' : '#9aa1ad';
      ctx.textAlign = 'center';
      ctx.fillText(`Mon Tue Wed Thu Fri Sat Sun`.split(' ')[i] + ` ${dayNum}`, x + colW / 2, 8);

      if (!d) {
        // future day in this week: grayed out
        ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.fillRect(x + 3, padT, colW - 6, plotH);
        return;
      }
      const startMin = (d.workStart - new Date(date + 'T00:00:00').getTime()) / 60000;
      const endMin = (d.workEnd - new Date(date + 'T00:00:00').getTime()) / 60000;

      // work-hours band
      ctx.fillStyle = 'rgba(255, 255, 255, 0.045)';
      ctx.fillRect(x + 3, yOf(startMin), colW - 6, yOf(endMin) - yOf(startMin));

      // overtime region past work end: darkest red tint
      if (d.overworkMin > 0) {
        ctx.fillStyle = 'rgba(128, 61, 58, 0.5)';
        ctx.fillRect(x + 3, yOf(endMin), colW - 6, d.overworkMin * scale);
      }

      // task blocks stacked from work start, height = planned minutes
      let cursor = startMin;
      for (const t of d.tasks) {
        const bh = Math.max(3, t.estimateMin * scale - 2);
        ctx.fillStyle = taskFill(t.status);
        ctx.fillRect(x + 5, yOf(cursor) + 1, colW - 10, bh);
        if (bh >= 15 && colW > 46) {
          ctx.fillStyle = 'rgba(10, 12, 16, 0.85)';
          ctx.textAlign = 'left';
          ctx.fillText(t.title.slice(0, Math.floor((colW - 14) / 5.4)), x + 8, yOf(cursor) + 4);
        }
        cursor += t.estimateMin;
      }

      // column frame
      ctx.strokeStyle = isToday ? 'rgba(174, 216, 252, 0.55)' : 'rgba(44, 49, 60, 0.9)';
      ctx.strokeRect(x + 2.5, padT - 0.5, colW - 5, plotH + 1);
    });
  }

  function renderMonth(canvas, data) {
    const { ctx, W, H } = prepCanvas(canvas, 420);
    ctx.clearRect(0, 0, W, H);
    const byKey = new Map(data.days.map((d) => [d.date, d]));
    const first = new Date(data.fromKey + 'T00:00:00');
    const lead = (first.getDay() + 6) % 7; // blanks before the 1st, Monday-first
    const daysInMonth = Number(data.toKey.slice(8)); // toKey is the month's last day
    const total = lead + daysInMonth;
    const rows = Math.ceil(total / 7);
    const padT = 24, gap = 6;
    const cellW = (W - gap * 8) / 7;
    const cellH = (H - padT - gap * (rows + 1)) / rows;

    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d, i) => {
      ctx.fillStyle = '#9aa1ad';
      ctx.fillText(d, gap + cellW * (i + 0.5), 12);
    });

    let cell = 0;
    const cursorDate = new Date(first);
    for (let i = 0; i < lead; i++) cell++; // leading blanks
    while (keyOf(cursorDate) <= data.toKey) {
      const date = keyOf(cursorDate);
      const col = cell % 7, row = Math.floor(cell / 7);
      const x = gap + cellW * col, y = padT + gap + (cellH + gap) * row;
      const d = byKey.get(date);
      const isToday = date === data.todayKey;
      const dayNum = Number(date.slice(8));

      if (!d || d.tasks.length === 0) {
        ctx.fillStyle = '#1a1d24'; // not there yet / no activity: grayed out
        ctx.strokeStyle = 'rgba(44, 49, 60, 0.9)';
      } else if (d.overworkMin >= OVERWORK_THRESHOLD_MIN) {
        ctx.fillStyle = 'rgba(128, 61, 58, 0.85)'; // overwork: red
        ctx.strokeStyle = 'rgba(128, 61, 58, 1)';
      } else {
        ctx.fillStyle = 'rgba(97, 179, 97, 0.55)'; // worked, no real overwork: green
        ctx.strokeStyle = 'rgba(97, 179, 97, 0.9)';
      }
      ctx.beginPath();
      ctx.roundRect(x, y, cellW, cellH, 8);
      ctx.fill();
      ctx.stroke();

      if (isToday) {
        ctx.strokeStyle = '#aed8fc';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(x - 1, y - 1, cellW + 2, cellH + 2, 9);
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      ctx.textAlign = 'left';
      ctx.fillStyle = d && d.tasks.length ? 'rgba(10, 12, 16, 0.9)' : '#9aa1ad';
      ctx.fillText(String(dayNum), x + 8, y + 12);
      if (d && d.overworkMin >= OVERWORK_THRESHOLD_MIN) {
        ctx.fillStyle = 'rgba(255, 235, 235, 0.95)';
        ctx.fillText(`+${Math.round(d.overworkMin)}m over`, x + 8, y + cellH - 12);
      } else if (d && d.tasks.length) {
        const done = d.tasks.filter((t) => t.status === 'green').length;
        ctx.fillStyle = 'rgba(10, 12, 16, 0.75)';
        ctx.fillText(`${done}/${d.tasks.length}`, x + 8, y + cellH - 12);
      }
      ctx.textAlign = 'center';
      cell++;
      cursorDate.setDate(cursorDate.getDate() + 1);
    }
  }

  window.Timeline = { render, hover, hoverEnd, renderWeek, renderMonth };
})();
