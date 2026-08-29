/**
 * 联招择校 — 冲3稳2保5 匹配算法（有效志愿版）
 *
 * 原则：排位权重大于分数；毒分数忽略；贴线先稳
 * 学校充足：冲3 · 稳2 · 保5；不足时凑满10所但不改真实定档
 */

const TIER_QUOTA = { 冲: 3, 稳: 2, 保: 5 }; // 学校充足时的目标结构
const TOTAL_TARGET = 10;

let DATA = null;
let lastResult = null;
let lastQuery = null;

async function loadData() {
  if (window.SCHOOLS_DATA && window.SCHOOLS_DATA.schools) {
    return window.SCHOOLS_DATA;
  }
  const res = await fetch("./data/schools.json");
  if (!res.ok) {
    throw new Error("数据加载失败。请双击 web/start.bat 后访问 http://127.0.0.1:8765/");
  }
  return res.json();
}

async function init() {
  DATA = await loadData();

  const grid = document.getElementById("provinceGrid");
  for (const p of DATA.meta.provinces) {
    const label = document.createElement("label");
    label.className = "province-chip";
    label.innerHTML = `<input type="checkbox" name="province" value="${p}" /> ${p}`;
    grid.appendChild(label);
  }

  const updateHint = () => {
    const selected = getSelectedProvinces();
    const hint = document.getElementById("provinceHint");
    hint.textContent = selected.length
      ? `已选 ${selected.length} 个省份：${selected.join("、")}`
      : "未勾选 = 不限省份";
  };

  grid.addEventListener("change", updateHint);
  document.getElementById("provinceAll").addEventListener("click", () => {
    grid.querySelectorAll('input[type="checkbox"]').forEach((el) => {
      el.checked = true;
    });
    updateHint();
  });
  document.getElementById("provinceClear").addEventListener("click", () => {
    grid.querySelectorAll('input[type="checkbox"]').forEach((el) => {
      el.checked = false;
    });
    updateHint();
  });

  document.getElementById("sourceNote").textContent = DATA.meta.sourceNote;

  document.getElementById("queryForm").addEventListener("submit", (e) => {
    e.preventDefault();
    runRecommend();
  });

  document.getElementById("showAll").addEventListener("change", () => {
    if (lastResult && lastQuery) renderResults(lastResult, lastQuery, { scroll: false });
  });
}

function getSelectedProvinces() {
  return [...document.querySelectorAll('#provinceGrid input[type="checkbox"]:checked')].map(
    (el) => el.value
  );
}

function runRecommend() {
  const track = document.getElementById("track").value;
  const score = Number(document.getElementById("score").value);
  const rank = Number(document.getElementById("rank").value);
  const provinces = getSelectedProvinces();
  const onlyNormal = document.getElementById("onlyNormal").checked;

  const result = recommend({
    schools: DATA.schools,
    track,
    score,
    rank,
    provinces,
    onlyNormal,
  });

  lastResult = result;
  lastQuery = { track, score, rank, provinces };
  renderResults(result, lastQuery);
}

function recommend({ schools, track, score, rank, provinces, onlyNormal }) {
  const provinceSet = new Set(provinces || []);
  const pool = [];

  for (const school of schools) {
    if (school.excludeRecommend) continue;
    if (school.track !== track) continue;
    if (provinceSet.size && !provinceSet.has(school.province)) continue;
    if (onlyNormal && (school.isArt || school.isSport)) continue;
    if (school.minScore == null && school.minRank == null) continue;

    const evaluated = evaluateSchool(school, score, rank);
    if (evaluated) pool.push(evaluated);
  }

  // 从有效候选中精选 10 所：冲3稳2保5，贴合度优先、档内拉开梯度
  const selected = pickTopTen(pool, TIER_QUOTA, TOTAL_TARGET, rank);
  const poolSorted = sortDisplay(pool);

  return {
    rush: selected.filter((s) => s.tier === "冲"),
    stable: selected.filter((s) => s.tier === "稳"),
    safe: selected.filter((s) => s.tier === "保"),
    all: selected,
    poolAll: poolSorted,
    poolSize: pool.length,
  };
}

/**
 * 精选 10 所（在「全部」候选之上再筛选）
 * - 同校只留 1 条
 * - 冲：温和冲击优先 + 难度拉开 + 省份分散
 * - 稳：贴线优先
 * - 保：余量适中优先 + 省份分散（避免全堆同一省）
 * - 展示顺序按贴合成本，不再被纯声望打乱
 */
function pickTopTen(pool, quota, totalTarget, userRank) {
  const unique = dedupePoolBySchool(pool, userRank);
  const byTier = { 冲: [], 稳: [], 保: [] };
  for (const s of unique) {
    if (byTier[s.tier]) byTier[s.tier].push(s);
  }

  const picked = [];
  const usedName = new Set();
  const usedKey = new Set();
  const provCount = Object.create(null);

  const canTake = (s) => !usedKey.has(keyOf(s)) && !usedName.has(s.name);

  const commit = (s) => {
    picked.push({ ...s });
    usedKey.add(keyOf(s));
    usedName.add(s.name);
    const p = s.province || "";
    provCount[p] = (provCount[p] || 0) + 1;
  };

  const costNow = (s) =>
    pickCost(s, userRank) + provincePenalty(s.province, provCount);

  const takeByCost = (list, n, opts = {}) => {
    const gapFn = opts.gapFn;
    const minSpread = opts.minSpread || 0;
    const chosenGaps = [];
    let got = 0;

    const pass = (strictSpread) => {
      const ranked = list
        .filter(canTake)
        .sort((a, b) => costNow(a) - costNow(b));
      for (const s of ranked) {
        if (got >= n) break;
        if (!canTake(s)) continue;
        if (strictSpread && gapFn && minSpread > 0) {
          const g = gapFn(s);
          if (chosenGaps.some((cg) => Math.abs(cg - g) < minSpread)) continue;
        }
        commit(s);
        if (gapFn) chosenGaps.push(gapFn(s));
        got += 1;
      }
    };

    pass(Boolean(gapFn && minSpread > 0));
    if (got < n) pass(false);
    return got;
  };

  const mid = userRank >= 500 && userRank <= 3800;
  const rushSpread = mid
    ? Math.max(35, Math.round(userRank * 0.04))
    : Math.max(22, Math.round(userRank * 0.05));

  takeByCost(byTier["冲"], quota["冲"], {
    gapFn: (s) => (s.rankGap == null ? 900 : s.rankGap),
    minSpread: rushSpread,
  });
  takeByCost(byTier["稳"], quota["稳"]);
  takeByCost(byTier["保"], quota["保"], {
    gapFn: (s) => (s.rankGap == null ? 900 : Math.abs(s.rankGap)),
    minSpread: mid ? Math.max(40, Math.round(userRank * 0.05)) : 30,
  });

  if (picked.length < totalTarget) {
    const counts = { 冲: 0, 稳: 0, 保: 0 };
    for (const s of picked) counts[s.tier] += 1;
    while (picked.length < totalTarget) {
      const rest = unique
        .filter(canTake)
        .sort((a, b) => {
          const shortA = Math.max(0, (quota[a.tier] || 0) - counts[a.tier]);
          const shortB = Math.max(0, (quota[b.tier] || 0) - counts[b.tier]);
          if (shortA !== shortB) return shortB - shortA;
          return costNow(a) - costNow(b);
        });
      if (!rest.length) break;
      const s = rest[0];
      commit(s);
      counts[s.tier] += 1;
    }
  }

  return sortByTierThenCost(picked, userRank);
}

function provincePenalty(province, provCount) {
  const n = provCount[province || ""] || 0;
  if (n <= 0) return 0;
  if (n === 1) return 18;
  if (n === 2) return 45;
  return 80 + n * 20;
}

/** 同校多记录：保留综合成本更优的一条 */
function dedupePoolBySchool(pool, userRank) {
  const best = new Map();
  for (const s of pool) {
    const cost = pickCost(s, userRank);
    const prev = best.get(s.name);
    if (!prev || cost < prev.cost) best.set(s.name, { s, cost });
  }
  return [...best.values()].map((x) => x.s);
}

/**
 * 档内选取成本：越小越优先入选 Top10
 * 冲偏「够得着」、稳偏贴线、保偏「余量适中」
 */
function pickCost(s, userRank) {
  const gap = s.rankGap;
  const prestige = s.prestigeRank ?? 800;
  const incomplete = s.minScore == null || s.minRank == null ? 55 : 0;
  const mid = userRank >= 500 && userRank <= 3800;
  // 无排位仅有分数的记录：中间段大幅降权，避免挤进精选 10 所
  const scoreOnly = gap == null ? (mid ? 90 : 45) : 0;

  if (s.tier === "冲") {
    const g = gap == null ? 220 : Math.max(0, gap);
    const gapW = mid ? 3.2 : 2.2;
    const preW = mid ? 0.1 : 0.16;
    return g * gapW + prestige * preW + incomplete + scoreOnly;
  }
  if (s.tier === "稳") {
    const g = gap == null ? 60 : Math.abs(gap);
    return g * 4.0 + prestige * 0.08 + incomplete + scoreOnly;
  }
  const margin = gap == null ? 320 : Math.max(0, -gap);
  const ideal = mid
    ? Math.max(100, Math.round(userRank * 0.26))
    : Math.max(110, Math.round((userRank || 1200) * 0.32));
  return Math.abs(margin - ideal) * 1.9 + prestige * 0.16 + incomplete + scoreOnly;
}

/** Top10 展示：冲→稳→保，档内按精选成本 */
function sortByTierThenCost(list, userRank) {
  const order = { 冲: 0, 稳: 1, 保: 2 };
  return [...list].sort((a, b) => {
    const to = order[a.tier] - order[b.tier];
    if (to !== 0) return to;
    return pickCost(a, userRank) - pickCost(b, userRank);
  });
}

function keyOf(s) {
  return `${s.name}__${s.category}`;
}

/**
 * 冲稳保（排位为主，分数为辅）
 *
 * rankGap = 你的排位 - 院校最低排位（>0 更难）
 * - 有排位：一律先按排位定档
 * - 分数仅作轻量标签；与排位矛盾时以排位为准（不因分数否决排位结论）
 * - 院校分数若被标为不可信 / 运行时检测为毒分：完全忽略分数
 */
function isSchoolScoreToxic(school) {
  if (school.scoreReliable === false) return true;
  if (school.isArt || school.isSport) return false;
  const score = school.minScore;
  const rank = school.minRank;
  if (score == null || rank == null) return false;

  // 正常名校：高分+好排位
  if (score >= 640 && rank <= 250) return false;
  if (score >= 600 && rank <= 450) return false;
  if (score >= 560 && rank <= 700) return false;

  // 排位很前、分数过低
  if (rank <= 80 && score < 640) return true;
  if (rank <= 150 && score < 600) return true;
  if (rank <= 280 && score < 555) return true;
  if (rank <= 500 && score < 520) return true;
  if (rank <= 700 && score < 490) return true;

  // 分数很高、排位很差
  if (score >= 640 && rank > 800) return true;
  if (score >= 610 && rank > 1500) return true;
  if (score >= 580 && rank > 2600) return true;
  return false;
}

function evaluateSchool(school, userScore, userRank) {
  const hasRank = school.minRank != null && userRank > 0;
  const scoreToxic = isSchoolScoreToxic(school);
  const hasScore =
    school.minScore != null && userScore > 0 && !scoreToxic;
  const scoreDiff = hasScore ? userScore - school.minScore : null;
  const rankRatio = hasRank ? userRank / Math.max(school.minRank, 1) : null;

  let tier = null;
  let fit = 0;
  let chanceLabel = "";
  let method = "";

  if (hasRank) {
    method = "rank";
    const schoolRank = school.minRank;
    const gap = userRank - schoolRank;

    // 高分宽松；中间段按用户定义：排位 500–3800 冲/稳收紧
    const topBand = userRank < 500;
    const midBand = userRank >= 500 && userRank <= 3800;
    const reachWindow = topBand
      ? Math.max(55, Math.round(userRank * 0.5))
      : midBand
        ? Math.max(50, Math.round(userRank * 0.26))
        : Math.max(110, Math.round(userRank * 0.48));
    // 稳：仅贴线附近；中间段几乎不允许“排位明显更差仍算稳”
    const stableWindow = topBand
      ? Math.max(10, Math.round(userRank * 0.12))
      : midBand
        ? Math.max(12, Math.round(userRank * 0.08))
        : Math.max(35, Math.round(userRank * 0.14));
    const stableHardCap = midBand
      ? Math.max(6, Math.round(stableWindow * 0.35))
      : stableWindow;
    const safeDepth = topBand
      ? Math.max(90, Math.round(userRank * 0.6))
      : Math.max(180, Math.round(userRank * 0.7));
    const safeCap = topBand
      ? Math.max(280, Math.round(userRank * 1.25))
      : midBand
        ? Math.max(360, Math.round(userRank * 1.15))
        : Math.max(480, Math.round(userRank * 1.45));

    // ① 冲：略难于往年线；中间段窗口更窄
    if (gap > stableHardCap && gap <= reachWindow) {
      tier = "冲";
      fit = Math.abs(gap / reachWindow - 0.35);
      chanceLabel = "冲击可试";
    } else if (gap >= -stableWindow && gap <= stableHardCap) {
      tier = "稳";
      fit = Math.abs(gap) / Math.max(stableWindow, 1);
      chanceLabel =
        gap > 0 ? "压线匹配" : gap < 0 ? "略有余量" : "高度吻合";
    } else if (gap < 0 && -gap <= safeCap) {
      tier = "保";
      fit = Math.abs(-gap - safeDepth * 0.55) / Math.max(safeCap, 1);
      chanceLabel = -gap > safeDepth ? "较稳保底" : "留有余量";
    }

    if (!tier && rankRatio != null) {
      // 中间段比率兜底也收紧，避免把明显更高的校标成冲/稳
      const rushHi = midBand ? 1.22 : topBand ? 1.55 : 1.45;
      const rushLo = midBand ? 1.04 : 1.05;
      const stableLo = midBand ? 0.94 : 0.88;
      if (rankRatio > rushLo && rankRatio <= rushHi) {
        tier = "冲";
        fit = Math.abs(rankRatio - 1.12);
        chanceLabel = "冲击可试";
      } else if (rankRatio >= stableLo && rankRatio <= rushLo) {
        tier = "稳";
        fit = Math.abs(rankRatio - 1);
        chanceLabel = "匹配较好";
      } else if (rankRatio >= 0.5 && rankRatio < stableLo) {
        tier = "保";
        fit = Math.abs(rankRatio - 0.72);
        chanceLabel = "留有余量";
      }
    }

    if (!tier) return null;

    // 分数辅助：中间段更容易把“勉强冲”降为稳，或把偏难的稳剔出
    if (hasScore) {
      const nearMiss = Math.max(3, Math.min(6, Math.round(schoolRank * 0.03)));
      const rankSaysHard = gap > stableHardCap;
      const rankSaysEasy = gap < -stableWindow;
      const scoreSaysEasy = scoreDiff >= 12;
      const scoreSaysHard = scoreDiff <= -12;

      if (
        tier === "冲" &&
        scoreDiff >= 0 &&
        gap > 0 &&
        gap <= nearMiss
      ) {
        tier = "稳";
        fit = gap / Math.max(nearMiss, 1);
        chanceLabel = "分数达标·排位略紧";
      } else if (midBand && tier === "冲" && scoreDiff >= 8 && gap <= reachWindow * 0.45) {
        tier = "稳";
        fit = Math.abs(gap) / Math.max(stableWindow, 1);
        chanceLabel = "分数够线·排位略紧";
      } else if (midBand && tier === "稳" && gap > 0 && scoreDiff < 0) {
        // 中间段：排位已偏难且分数不够，不纳入有效志愿
        return null;
      } else if (midBand && tier === "冲" && scoreDiff <= -18) {
        return null;
      } else if (rankSaysHard && scoreSaysEasy) {
        chanceLabel = `${chanceLabel}·以排位为准`;
        fit = Math.min(fit + 0.08, 1.3);
      } else if (rankSaysEasy && scoreSaysHard) {
        chanceLabel = `${chanceLabel}·以排位为准`;
        fit = Math.min(fit + 0.08, 1.3);
      } else if (tier === "稳" && scoreDiff > 45) {
        chanceLabel = "排位贴线·分数宽裕";
      }
    } else if (scoreToxic) {
      chanceLabel = `${chanceLabel}·排位为准`;
    }
  } else if (hasScore) {
    method = "score";
    const diff = scoreDiff;
    const midScore = userScore >= 480 && userScore <= 600;

    if (midScore) {
      // 中间分数仅按分数定档时更保守
      if (diff >= -18 && diff <= -4) {
        tier = "冲";
        fit = Math.abs(diff + 10) / 18;
        chanceLabel = "冲击可试";
      } else if (diff >= -3 && diff <= 18) {
        tier = "稳";
        fit = Math.abs(diff - 5) / 18;
        chanceLabel = diff >= 0 ? "分数已达线" : "压线匹配";
      } else if (diff >= 16 && diff <= 55) {
        tier = "保";
        fit = Math.abs(diff - 32) / 40;
        chanceLabel = diff > 40 ? "较稳保底" : "留有余量";
      } else {
        return null;
      }
    } else if (diff >= -32 && diff <= -3) {
      tier = "冲";
      fit = Math.abs(diff + 14) / 32;
      chanceLabel = diff < -20 ? "冲击可试" : "冲击可试";
    } else if (diff >= -6 && diff <= 26) {
      tier = "稳";
      fit = Math.abs(diff - 6) / 26;
      chanceLabel = diff >= 0 ? "分数已达线" : "压线匹配";
    } else if (diff >= 20 && diff <= 72) {
      tier = "保";
      fit = Math.abs(diff - 40) / 52;
      chanceLabel = diff > 50 ? "较稳保底" : "留有余量";
    } else {
      return null;
    }
  } else {
    return null;
  }

  const prestige =
    school.prestigeRank ??
    Math.sqrt((school.uniRank ?? 600) * (school.alumniRank ?? 620));

  return {
    ...school,
    tier,
    fit,
    chanceLabel,
    method,
    scoreToxic,
    uniRank: school.uniRank ?? 9999,
    alumniRank: school.alumniRank ?? 9999,
    prestigeRank: prestige,
    rankRatio,
    scoreDiff,
    rankGap: hasRank ? userRank - school.minRank : null,
  };
}


/** 同档：综合声望优先；同分档更看排位贴合度 */
function compareSchool(a, b) {
  const pa = a.prestigeRank ?? 9999;
  const pb = b.prestigeRank ?? 9999;
  if (Math.abs(pa - pb) > 0.8) return pa - pb;

  // 排位贴合优先于纯 fit（分数噪声大）
  const ga = Math.abs(a.rankGap ?? 9999);
  const gb = Math.abs(b.rankGap ?? 9999);
  if (ga !== gb && ga < 500 && gb < 500) {
    if (Math.abs(ga - gb) >= 8) return ga - gb;
  }

  const fitA = a.fit ?? 9;
  const fitB = b.fit ?? 9;
  if (Math.abs(fitA - fitB) > 0.12) return fitA - fitB;

  const ap = (a.is985 ? 2 : 0) + (a.is211 ? 1 : 0);
  const bp = (b.is985 ? 2 : 0) + (b.is211 ? 1 : 0);
  if (ap !== bp) return bp - ap;

  const sa = a.uniRank ?? 9999;
  const sb = b.uniRank ?? 9999;
  if (sa !== sb) return sa - sb;
  return (a.name || "").localeCompare(b.name || "", "zh");
}


function sortDisplay(list) {
  const order = { 冲: 0, 稳: 1, 保: 2 };
  const seen = new Set();
  const unique = [];
  for (const s of list) {
    const k = keyOf(s);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(s);
  }
  return unique.sort((a, b) => {
    const to = order[a.tier] - order[b.tier];
    if (to !== 0) return to;
    return compareSchool(a, b);
  });
}

function renderResults(result, query, opts = {}) {
  const section = document.getElementById("results");
  const list = document.getElementById("schoolList");
  const summary = document.getElementById("resultsSummary");
  const title = document.getElementById("resultsTitle");
  const modeEl = document.getElementById("showAll");
  const showAll = modeEl && modeEl.checked;
  const shouldScroll = opts.scroll !== false;
  section.hidden = false;

  const provinceText = query.provinces?.length
    ? ` · ${query.provinces.join("、")}`
    : " · 全国";

  const finalList = showAll
    ? result.poolAll || []
    : (result.all || []).slice(0, TOTAL_TARGET);

  const rushN = finalList.filter((s) => s.tier === "冲").length;
  const stableN = finalList.filter((s) => s.tier === "稳").length;
  const safeN = finalList.filter((s) => s.tier === "保").length;

  if (title) {
    title.textContent = showAll
      ? `全部有效候选（${result.poolSize} 所）`
      : "为你匹配的 10 所学校";
  }

  summary.innerHTML = `${query.track}类 ${query.score} 分 / 排位 ${query.rank}${provinceText} · 有效候选 <strong>${result.poolSize}</strong> 所 · 当前显示 ${finalList.length} 所（冲${rushN}·稳${stableN}·保${safeN}）`;

  if (!finalList.length) {
    list.innerHTML = `<div class="empty">当前分数/排位附近没有足够“有效志愿”院校。可尝试放宽省份，或微调分数排位后再查。</div>`;
    if (shouldScroll) section.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  list.innerHTML = finalList
    .map((s, idx) => {
      const rankBits = [];
      if (s.uniRank && s.uniRank < 900) rankBits.push(`软科${s.uniRank}`);
      if (s.alumniRank && s.alumniRank < 900) rankBits.push(`校友会${s.alumniRank}`);
      const uniRankText = rankBits.length ? rankBits.join(" · ") : null;
      const tags = [
        uniRankText,
        s.province,
        s.is985 ? "985" : null,
        s.is211 ? "211" : null,
        s.category,
      ]
        .filter(Boolean)
        .map((t) => {
          const gold =
            t === "985" ||
            t === "211" ||
            String(t).includes("软科") ||
            String(t).includes("校友会");
          return `<span class="tag${gold ? " gold" : ""}">${t}</span>`;
        })
        .join("");

      const scoreText =
        s.minScore != null
          ? `${s.minScore}<span style="font-size:0.75rem"> 分</span>`
          : "暂无分数";
      const rankText =
        s.minRank != null ? `最低排位 ${s.minRank}` : "暂无排位";

      return `
      <article class="school-row" data-tier="${s.tier}" style="animation-delay:${idx * 0.04}s">
        <div class="tier-badge">${s.tier}</div>
        <div class="school-main">
          <h3>${escapeHtml(s.name)}</h3>
          <div class="meta-line">${tags}</div>
          <p class="major-line">推荐优势专业：<strong>${escapeHtml(s.bestMajor)}</strong></p>
        </div>
        <div class="stats">
          <p class="score">${scoreText}</p>
          <p class="rank">${rankText}</p>
          <p class="chance">${escapeHtml(s.chanceLabel)}</p>
        </div>
      </article>`;
    })
    .join("");

  if (shouldScroll) section.scrollIntoView({ behavior: "smooth", block: "start" });
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

init().catch((err) => {
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div class="empty" style="margin:1rem">${escapeHtml(err.message)}</div>`
  );
});
