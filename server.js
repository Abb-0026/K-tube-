import express from "express";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import path from "path";
import { execSync } from "child_process";   

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://hrbnspsmvlnlndkrfeij.supabase.co',
  'sb_publishable_7H3Y61-DO70Z4SKU2Dvgrg_UST3d5iF'
);

import { execSync, exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";


const app = express();
const PORT = process.env.PORT || 3000;

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 静的ファイル配信（css, js, API.json などを公開）
app.use(express.static(__dirname));

// ====================== グローバル変数 ======================
let totalAccesses = 0;
let todayAccesses = 0;
let todayDate = new Date().toISOString().split('T')[0];
let activeUsers = new Map();
const ONLINE_TIMEOUT = 5 * 60 * 1000;

// yt-dlp キャッシュ
const videoCache = new Map();
const CACHE_TIME = 1000 * 60 * 60 * 3; // 3時間

// ====================== ルート ======================
app.get("/", async (req, res) => {
  totalAccesses++;
  todayAccesses++;
  updateTodayCount();
  await incrementAccesses(); // ← await 必須
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/watch.html", async (req, res) => {
  totalAccesses++;
  todayAccesses++;
  updateTodayCount();
  await incrementAccesses();
  res.sendFile(path.join(__dirname, "watch.html"));
});

// 今日の日付が変わったらリセット
function updateTodayCount() {
  const currentDate = new Date().toISOString().split('T')[0];
  if (currentDate !== todayDate) {
    todayAccesses = 0;
    todayDate = currentDate;
  }
}

async function incrementAccesses() {
  // JSTで日付(YYYY-MM-DD)を作る
  const today = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .replace(/\//g, '-'); // "YYYY-MM-DD" に寄せる

  // 念のためフォーマットがズレてないか（"YYYY-MM-DD" になるはず）
  // console.log({ today });

  // 今日行があるか
  const { data: todayRows, error: selectError } = await supabase
    .from('access_stats')
    .select('*')
    .eq('date', today);

  if (selectError) {
    console.error("Select error:", selectError);
    return;
  }

  // 今日行があるなら +1（累計も+1）
  if (todayRows && todayRows.length > 0) {
    const row = todayRows[0];

    const { error: updateError } = await supabase
      .from('access_stats')
      .update({
        total_views: row.total_views + 1,
        today_views: row.today_views + 1,
      })
      .eq('id', row.id);

    if (updateError) console.error("Update error:", updateError);
    return;
  }

  // 今日行が無いなら、直前日の total_views を取って +1
  const { data: prevRows, error: prevError } = await supabase
    .from('access_stats')
    .select('total_views')
    .lt('date', today)
    .order('date', { ascending: false })
    .limit(1);

  if (prevError) {
    console.error("Prev select error:", prevError);
    return;
  }

  const prevTotal = prevRows && prevRows.length > 0 ? prevRows[0].total_views : 0;

  const { error: insertError } = await supabase
    .from('access_stats')
    .insert({
      date: today,
      total_views: prevTotal + 1, // 全期間累計を維持
      today_views: 1,
    });

  if (insertError) console.error("Insert error:", insertError);
}

app.get("/video", async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: "video id required" });

  // キャッシュ確認
  const cached = videoCache.get("video_" + videoId);
  if (cached && Date.now() - cached.time < CACHE_TIME) {
    console.log("CACHE HIT:", videoId);
    return res.json(cached.data);
  }

  try {
    const output = execSync(
      `yt-dlp --cookies youtube-cookies.txt --js-runtimes node --remote-components ejs:github --sleep-requests 1 --user-agent "Mozilla/5.0" --get-url -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]" https://youtu.be/${videoId}`
    ).toString().trim().split("\n");

    const videoUrl = output[0] || "";
    const audioUrl = output[1] || videoUrl;

    if (!videoUrl) {
      throw new Error("No valid stream URL extracted. Cookies may be expired.");
    }

    const data = {
      video: videoUrl,
      audio: audioUrl,
      source: "yt-dlp"
    };

    // キャッシュ保存
    videoCache.set("video_" + videoId, {
      data,
      time: Date.now()
    });

    console.log("CACHE SAVE:", videoId);

    res.json(data);

  } catch (e) {
    console.error("yt-dlp error:", e.message, e.stack);
    res.status(500).json({
      error: "failed_to_extract_video",
      message: e.message.includes("Sign in") 
        ? "YouTubeがボット判定しました。youtube-cookies.txtを最新のものに更新してください" 
        : e.message
    });
  }
});


// 360p・音声＋映像 合体
app.get("/video360", async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: "video id required" });

  // キャッシュ確認
  const cached = videoCache.get("video360_" + videoId);
  if (cached && Date.now() - cached.time < CACHE_TIME) {
    console.log("CACHE HIT 360:", videoId);
    return res.json(cached.data);
  }

  try {
    const output = execSync(
      `yt-dlp --cookies youtube-cookies.txt \
--js-runtimes node \
--remote-components ejs:github \
--sleep-requests 1 \
--user-agent "Mozilla/5.0" \
--get-url \
-f "best[ext=mp4][height<=360]/best[ext=mp4]/best" \
https://youtu.be/${videoId}`
    ).toString().trim();

    if (!output) throw new Error("No valid 360p stream");

    const data = {
      video: output,
      audio: output,
      source: "yt-dlp-360p-progressive"
    };

    // キャッシュ保存
    videoCache.set("video360_" + videoId, {
      data,
      time: Date.now()
    });

    console.log("CACHE SAVE 360:", videoId);

    res.json(data);

  } catch (e) {
    console.error("yt-dlp 360p error:", e.message);
    res.status(500).json({
      error: "failed_to_extract_video_360",
      message: e.message
    });
  }
});

// ====================== 字幕取得（yt-dlp ベース） ======================

// 字幕リスト取得
app.get('/captions/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const label = req.query.label;

  // ── リスト取得 ──
  if (!label) {
    try {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ktube-subs-'));
      const outTemplate = path.join(tmpDir, 'sub');

      // --list-subs で利用可能な字幕を取得（ダウンロードはしない）
      let listOutput = '';
      try {
        const { stdout } = await execAsync(
          `yt-dlp --cookies youtube-cookies.txt --js-runtimes node --remote-components ejs:github --list-subs "https://youtu.be/${videoId}"`,
          { timeout: 20000, maxBuffer: 1024 * 1024 }
        );
        listOutput = stdout;
      } catch (e) {
        // --list-subs が失敗しても、字幕ダウンロードで判定できるので続行
        console.warn('yt-dlp --list-subs failed:', e.message);
      }

      // --list-subs の出力から言語コードを抽出
      // 例:
      //   Available automatic captions for <id>:
      //   Language    Name              Formats
      //   ja          Japanese          vtt, ttml, srv3, srv2, srv1, json3
      const langs = new Set();

      if (listOutput) {
        const lines = listOutput.split('\n');
        let inSubs = false;
        for (const line of lines) {
          if (/Available (automatic )?subtitles/i.test(line)) { inSubs = true; continue; }
          if (/^\[/.test(line)) { inSubs = false; continue; }
          if (!inSubs) continue;

          const trimmed = line.trim();
          if (!trimmed) continue;
          if (/^Language\s+Name/i.test(trimmed)) continue;

          // 先頭トークンが言語コード
          const m = trimmed.match(/^([a-zA-Z0-9\-_]+)\s+/);
          if (m) langs.add(m[1]);
        }
      }

      // --list-subs が取れなかった場合は、よく使う言語を総当たりで確認
      if (langs.size === 0) {
        const candidates = ['ja', 'en'];
        for (const lang of candidates) {
          try {
            await execAsync(
              `yt-dlp --cookies youtube-cookies.txt --js-runtimes node --remote-components ejs:github --skip-download --write-subs --write-auto-subs --sub-lang ${lang} --sub-format vtt -o "${outTemplate}" "https://youtu.be/${videoId}"`,
              { timeout: 25000, maxBuffer: 1024 * 1024 }
            );
            const files = await fs.readdir(tmpDir);
            if (files.some(f => f.endsWith(`.${lang}.vtt`))) langs.add(lang);
          } catch (e) {}
        }
      }

      await fs.rm(tmpDir, { recursive: true, force: true });

      const captions = [...langs].map(lang => ({
        label: langLabel(lang),
        languageCode: lang,
        url: `${videoId}:${lang}`
      }));

      return res.json({ captions });
    } catch (e) {
      console.error('captions list failed:', e.message);
      return res.status(500).json({ error: 'captions list failed', message: e.message });
    }
  }

  // ── VTT 取得 ──
  try {
    // label は "ja" または "videoId:ja" 形式
    const lang = label.includes(':') ? label.split(':').pop() : label;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ktube-subs-'));
    const outTemplate = path.join(tmpDir, 'sub');

    try {
      await execAsync(
        `yt-dlp --cookies youtube-cookies.txt --js-runtimes node --remote-components ejs:github --skip-download --write-subs --write-auto-subs --sub-lang ${lang} --sub-format vtt -o "${outTemplate}" "https://youtu.be/${videoId}"`,
        { timeout: 30000, maxBuffer: 1024 * 1024 }
      );
    } catch (e) {
      console.warn('yt-dlp subs download failed:', e.message);
      await fs.rm(tmpDir, { recursive: true, force: true });
      return res.status(500).send('caption vtt failed');
    }

    const files = await fs.readdir(tmpDir);
    // 例: sub.ja.vtt / sub.ja-orig.vtt
    const vttFile = files.find(f => f.endsWith(`.${lang}.vtt`)) ||
                    files.find(f => f.includes(`.${lang}`) && f.endsWith('.vtt')) ||
                    files.find(f => f.endsWith('.vtt'));

    if (!vttFile) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      return res.status(404).send('no vtt file');
    }

    let vtt = await fs.readFile(path.join(tmpDir, vttFile), 'utf-8');
    await fs.rm(tmpDir, { recursive: true, force: true });

    // yt-dlp の VTT は先頭に "WEBVTT" ヘッダーがあるが、
    // ない場合（auto-generated の特殊形式）は付与
    if (!vtt.trimStart().startsWith('WEBVTT')) {
      vtt = 'WEBVTT\n\n' + vtt;
    }

    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(vtt);
  } catch (e) {
    console.error('caption vtt failed:', e.message);
    res.status(500).send('caption vtt failed');
  }
});

// 翻訳先言語リスト（yt-dlp では翻訳字幕を直接取得できないため、固定リストを返す）
app.get('/captions/:videoId/translate-langs', async (req, res) => {
  const langs = [
    { code: 'ja', name: '日本語' },
    { code: 'en', name: 'English' },
    { code: 'ko', name: '한국어' },
    { code: 'zh-Hans', name: '简体中文' },
    { code: 'zh-Hant', name: '繁體中文' },
    { code: 'es', name: 'Español' },
    { code: 'fr', name: 'Français' },
    { code: 'de', name: 'Deutsch' },
    { code: 'pt', name: 'Português' },
    { code: 'ru', name: 'Русский' },
    { code: 'ar', name: 'العربية' },
    { code: 'hi', name: 'हिन्दी' },
  ];
  res.json({ langs });
});

// 翻訳字幕 VTT 取得
// yt-dlp は YouTube の翻訳字幕を直接ダウンロードできないため、
// 元の字幕（自動生成含む）を取得し、YouTube の timedtext に tlang を付けて取得する
app.get('/captions/:videoId/translate', async (req, res) => {
  const { videoId } = req.params;
  const tlang = req.query.tlang;
  if (!tlang) return res.status(400).send('tlang required');

  try {
    // まず元の字幕を yt-dlp で取得して baseUrl を得る代わりに、
    // yt-dlp の --write-auto-subs で取得した VTT を翻訳するのは困難なので、
    // YouTube の timedtext を yt-dlp の Cookie 付きで叩く
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ktube-tr-'));
    const outTemplate = path.join(tmpDir, 'sub');

    // 自動生成字幕（asr）をベースに取得
    try {
      await execAsync(
        `yt-dlp --cookies youtube-cookies.txt --js-runtimes node --remote-components ejs:github --skip-download --write-auto-subs --sub-lang ja,en --sub-format vtt -o "${outTemplate}" "https://youtu.be/${videoId}"`,
        { timeout: 30000, maxBuffer: 1024 * 1024 }
      );
    } catch (e) {
      console.warn('translate base subs failed:', e.message);
    }

    const files = await fs.readdir(tmpDir);
    const baseFile = files.find(f => f.endsWith('.vtt'));
    await fs.rm(tmpDir, { recursive: true, force: true });

    if (!baseFile) {
      return res.status(404).send('no base subtitles for translation');
    }

    // yt-dlp で取得した VTT をそのまま返す（翻訳は不可）
    // 注: yt-dlp は YouTube の翻訳字幕エンドポイントを直接サポートしていないため、
    // ここでは「元の字幕をそのまま返す」フォールバックとする
    return res.status(501).json({
      error: 'translation_not_supported',
      message: 'yt-dlp ベースでは翻訳字幕は取得できません。元の字幕をご利用ください。'
    });
  } catch (e) {
    console.error('translate failed:', e.message);
    res.status(500).send('translate failed');
  }
});

// 言語コード → 表示名
function langLabel(code) {
  const map = {
    'ja': '日本語', 'en': 'English', 'ko': '한국어',
    'zh-Hans': '简体中文', 'zh-Hant': '繁體中文',
    'es': 'Español', 'fr': 'Français', 'de': 'Deutsch',
    'pt': 'Português', 'ru': 'Русский', 'ar': 'العربية',
    'hi': 'हिन्दी', 'it': 'Italiano', 'id': 'Bahasa Indonesia',
    'th': 'ไทย', 'vi': 'Tiếng Việt', 'tr': 'Türkçe',
    'ja-orig': '日本語（自動生成）', 'en-orig': 'English (auto)',
  };
  return map[code] || code;
}

// ====================== /api/v2/video（修正版） ======================
const pipedInstances = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.syncpundit.io',
  'https://api-piped.mha.fi',
  'https://piped-api.garudalinux.org',
  'https://pipedapi.rivo.lol',
  'https://pipedapi.leptons.xyz',
  'https://piped-api.lunar.icu',
  'https://ytapi.dc09.ru',
  'https://pipedapi.colinslegacy.com',
  'https://yapi.vyper.me',
  'https://api.looleh.xyz',
  'https://piped-api.cfe.re',
  'https://pipedapi.r4fo.com',
  'https://pipedapi.nosebs.ru',
  'https://pipedapi-libre.kavin.rocks',
  'https://pa.mint.lgbt',
  'https://pa.il.ax',
  'https://piped-api.privacy.com.de',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.in.projectsegfau.lt',
  'https://pipedapi.us.projectsegfau.lt',
  'https://api.piped.privacydev.net',
  'https://pipedapi.palveluntarjoaja.eu',
  'https://pipedapi.smnz.de',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.qdi.fi',
  'https://piped-api.hostux.net',
  'https://pdapi.vern.cc',
  'https://pipedapi.pfcd.me',
  'https://pipedapi.frontendfriendly.xyz',
  'https://api.piped.yt',
  'https://pipedapi.astartes.nl',
  'https://pipedapi.osphost.fi',
  'https://pipedapi.simpleprivacy.fr',
  'https://pipedapi.drgns.space',
  'https://piapi.ggtyler.dev',
  'https://api.watch.pluto.lat',
  'https://piped-backend.seitan-ayoub.lol',
  'https://pipedapi.owo.si',
  'https://api.piped.minionflo.net',
  'https://pipedapi.nezumi.party',
  'https://pipedapi.ducks.party',
  'https://pipedapi.ngn.tf',
  'https://pipedapi.coldforge.xyz',
  'https://piped-api.codespace.cz',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.phoenixthrush.com',
  'https://schaunapi.ehwurscht.at',
  'https://pipedapi.darkness.services',
  'https://pipedapi.andreafortuna.org',
  'https://nyc1.iv.ggtyler.dev',
];

const invidiousInstances = [
  'https://invid-api.poketube.fun',
  'https://nyc1.iv.ggtyler.dev',
  'https://cal1.iv.ggtyler.dev',
  'https://invidious.nikkosphere.com',
  'https://lekker.gay',
  'https://invidious.f5.si',
  'https://inv.nadeko.net',
  'https://invidious.ritoge.com',
  'https://invidious.ducks.party',
  'https://super8.absturztau.be',
  'https://invidious.darkness.services',
  'https://yt.omada.cafe',
  'https://iv.melmac.space',
  'https://iv.duti.dev',
  'https://invidious.tiekoetter.com',
  'https://iv.ggtyler.dev',
  'https://invidious.perennialte.ch',
  'https://invidious.jing.rocks',
  'https://yewtu.be',
  'https://invidious.private.coffee',
  'https://invidious.slipfox.xyz',
  'https://invidious.protokolla.fi',
  'https://inv.tux.pizza',
  'https://invidious.lunar.icu',
  'https://invidious.no-logs.com',
  'https://invidious.zapashcanon.fr',
  'https://invidious.dhusch.de',
  'https://invidious.reallyaweso.me',
  'https://invidious.kavin.rocks',
  'https://vid.puffyan.us',
  'https://invidious.xyz',
  'https://inv.zzls.xyz',
  'https://invidious.fdn.fr',
  'https://invidious.flokinet.to',
  'https://invidious.materialio.us',
  'https://iv.catgirl.cloud',
  'https://inv.kamuridesu.com',
  'https://inv.thepixora.com',
  'https://inv.eu.projectsegfau.lt',
  'https://inv.bp.projectsegfau.lt',
  'https://inv.perditum.com',
  'https://iteroni.com',
  'https://inv.jp.projectsegfau.lt',
  'https://inv.sg.projectsegfau.lt',
  'https://inv.ca.projectsegfau.lt',
  'https://inv.de.projectsegfau.lt',
  'https://usa-proxy2.poketube.fun',
  'https://invidious.nietzospannend.nl',
  'https://inv7.nadeko.net',
  'https://inv6.nadeko.net',
  'https://inv8.nadeko.net',
  'https://inv9.nadeko.net',
  'https://invidious.io.lol',
  'https://cuddly.tube',
  'https://invidious.einfachzocken.eu',
  'https://y.com.sb',
  'https://invidious.epicsite.xyz',
  'https://inv1.nadeko.net',
  'https://inv2.nadeko.net',
  'https://inv3.nadeko.net',
  'https://inv4.nadeko.net',
  'https://inv5.nadeko.net',
  'https://yt.cdsp.cz',
  'https://invidious.projectsegfau.lt',
  'https://invidious.domain.glass',
  'https://clips.im.allmendenetz.de',
  'https://i.oyster.men',
  'https://youtube.vpn-home-net.de',
  'https://toob.unternet.org',
  'https://inv.antopie.org',
  'https://invidious.weblibre.org',
  'https://inv.in.projectsegfau.lt',
  'https://invidious-us.kavin.rocks',
  'https://invidious.zee.li',
  'https://tube.connect.cafe',
  'https://invidious.privacy.gd',
  'https://eu-proxy.poketube.fun',
  'https://inv.riverside.rocks',
  'https://invidious.site',
  'https://yt.artemislena.eu',
  'https://invidious.chunboan.zone',
  'https://invidious.vpsburti.com',
  'https://youtube.notrack.ch',
  'https://invidious.poast.org',
  'https://invidious.drivet.xyz',
  'https://video.weiler.rocks',
  'https://yt.beparanoid.de',
  'https://youtube.it-service-schopfheim.de',
  'https://monocles.live',
  'https://inv.us.projectsegfau.lt',
  'https://invidious.rndsh.it',
  'https://invidious.pussthecat.org',
  'https://youtube.lurkmore.com',
  'https://invidious.palejev.dscloud.me',
  'https://invidious.zecircle.xyz',
  'https://inv.owo.si',
  'https://inv.pistasjis.net',
  'https://invidious.qwik.space',
  'https://hyperpipe.surge.sh',
  'https://inv.frail.duckdns.org',
  'https://invidious.notraxx.ch',
  'https://youtube.mosesmang.com',
  'https://inv.zoomerville.com',
  'https://id.420129.xyz',
  'https://invidious.0011.lt',
  'https://invidious.adminforge.de',
  'https://invidious.esmailelbob.xyz',
  'https://invidious.lunivers.trade',
  'https://iv.datura.network',
  'https://pol1.iv.ggtyler.dev',
  'https://invidious.drgns.space',
  'https://invidious.mutahar.rocks',
  'https://invidious.privacyredirect.com',
  'https://invidious.catspeed.cc',
  'https://youtube.076.ne.jp',
];

// 重複除去 + 先頭N件に絞る
const UNIQUE_PIPED = [...new Set(pipedInstances)];
const UNIQUE_INVIDIOUS = [...new Set(invidiousInstances)];
const MAX_PIPED = 20;
const MAX_INVIDIOUS = 20;
const API_TIMEOUT = 6000;

app.get('/api/v2/video', async (req, res) => {
  const videoId = req.query.v;
  if (!videoId) return res.status(400).json({ error: "video id required" });

  // ── Piped と Invidious を並列で叩き、最速応答を返す ──
  const pipedTasks = UNIQUE_PIPED.slice(0, MAX_PIPED).map(async (base) => {
    const url = `${base}/streams/${videoId}`;
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(API_TIMEOUT)
    });
    if (!r.ok) throw new Error(`Piped ${base} → ${r.status}`);
    return { source: 'piped', base, data: await r.json() };
  });

  const invTasks = UNIQUE_INVIDIOUS.slice(0, MAX_INVIDIOUS).map(async (base) => {
    const url = `${base}/api/v1/videos/${videoId}`;
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; K-tube/1.0)' },
      signal: AbortSignal.timeout(API_TIMEOUT)
    });
    if (!r.ok) throw new Error(`Invidious ${base} → ${r.status}`);
    const data = await r.json();
    return { source: 'invidious', base, data };
  });

  try {
    const winner = await Promise.any([...pipedTasks, ...invTasks]);
    const data = winner.data;

    // ── Invidious 形式を Piped 形式に正規化 ──
    if (winner.source === 'invidious') {
      const result = {
        title: data.title || "不明",
        description: data.description || "",
        viewCount: data.viewCount || 0,
        likeCount: data.likeCount || 0,
        published: data.published
          ? new Date(data.published * 1000).toISOString()
          : null,
        uploader: data.author || "不明",
        uploaderUrl: `/channel/${data.authorId || ""}`,
        uploaderAvatar: data.authorThumbnails?.[data.authorThumbnails.length - 1]?.url || "",
        thumbnail: data.videoThumbnails?.find(t => t.quality === "maxres")?.url
          || data.videoThumbnails?.[0]?.url || "",
        lengthSeconds: data.lengthSeconds || 0,
        adaptiveFormats: data.adaptiveFormats || [],
        formatStreams: data.formatStreams || [],
        relatedStreams: data.recommendedVideos || []
      };
      return res.json(result);
    }

    // Piped はそのまま返す
    return res.json(data);

  } catch (e) {
    console.error('/api/v2/video all failed:', e.message);
    res.status(503).json({ error: "All Piped/Invidious instances failed" });
  }
});

// プロキシ（動画チャンク配信用）
app.get("/proxy", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("URL required");

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  const lastAccess = activeUsers.get(ip) || 0;
  if (now - lastAccess > ONLINE_TIMEOUT) {
    activeUsers.set(ip, now);
  }

  const currentDate = new Date().toISOString().split('T')[0];
  if (currentDate !== todayDate) {
    todayAccesses = 0;
    todayDate = currentDate;
  }

  
  totalAccesses++;
todayAccesses++;
await incrementAccesses();

  const range = req.headers.range || "bytes=0-";

  try {
    const response = await fetch(url, {
      headers: { Range: range }
    });

    const headers = {
      "Content-Type": response.headers.get("content-type") || "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Range": response.headers.get("content-range") || range,
      "Content-Length": response.headers.get("content-length")
    };

    res.writeHead(response.status, headers);
    response.body.pipe(res);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("Proxy failed");
  }
});

// サムネイルプロキシ
app.get("/thumb-proxy", async (req, res) => {
  const url = req.query.url;
  if (!url) {
    console.log("No thumbnail URL");
    return res.status(400).send("URL required");
  }

  console.log(`Proxying thumbnail: ${url}`);

  const allowedHosts = ['yt3.ggpht.com', 'ggpht.com', 'googleusercontent.com', 'pipedproxy', 'private.coffee', 'kavin.rocks'];
  try {
    const urlObj = new URL(url);
    if (!allowedHosts.some(h => urlObj.hostname.includes(h))) {
      console.log(`Blocked invalid host: ${urlObj.hostname}`);
      return res.status(403).send("Invalid host");
    }

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Referer": "https://www.youtube.com/",
        "Origin": "https://www.youtube.com",
        "Accept": "image/webp,*/*;q=0.8"
      },
      redirect: 'follow'
    });

    if (!response.ok) {
      const err = await response.text().catch(() => '');
      console.error(`Fetch failed ${response.status}: ${err}`);
      return res.status(response.status).send("Fetch error");
    }

    const buffer = await response.arrayBuffer();

    const headers = {
      "Content-Type": response.headers.get("content-type") || "image/webp",
      "Content-Length": buffer.byteLength,
      "Cache-Control": "public, max-age=604800",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
      "Vary": "Origin"
    };

    res.writeHead(200, headers);
    res.end(Buffer.from(buffer));
  } catch (err) {
    console.error("Proxy error:", err.message);
    res.status(500).send("Proxy failed");
  }
});

// HLS用プロキシ
app.get("/proxy-hls", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("URL required");

  try {
    const r = await fetch(url);
    let text = await r.text();

    text = text.replace(
      /(https?:\/\/[^\s]+)/g,
      (m) => m.includes("googlevideo.com") ? `/proxy?url=${encodeURIComponent(m)}` : m
    );

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    res.status(500).send("HLS proxy failed");
  }
});



app.get('/piped/*', async (req, res) => {
  const path = req.path.replace('/piped', '');
  const query = new URLSearchParams(req.query).toString();

  for (const base of UNIQUE_PIPED) {
    const targetUrl = `${base}${path}${query ? '?' + query : ''}`;
    try {
      const response = await fetch(targetUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      if (response.ok) {
        const contentType = response.headers.get('content-type');
        res.setHeader('Content-Type', contentType || 'application/json');
        return response.body.pipe(res);
      }
      console.log(`Instance ${base} failed with ${response.status}`);
    } catch (e) {
      console.error(`Instance ${base} error:`, e.message);
    }
  }

  res.status(503).json({ error: 'All Piped instances failed' });
});

// ====================== Invidious プロキシ ======================
const INV_API_LIST_URL = 'https://splendid-jelly-e731bd.netlify.app/.netlify/functions/list';

let invidiousApiCache = null;
let invidiousApiCacheTime = 0;
const INV_CACHE_TTL = 1000 * 60 * 30; // 30分キャッシュ

async function getInvidiousApis() {
  if (invidiousApiCache && Date.now() - invidiousApiCacheTime < INV_CACHE_TTL) {
    return invidiousApiCache;
  }
  try {
    const res = await fetch(INV_API_LIST_URL, {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`list fetch ${res.status}`);
    const data = await res.json();
    const apis = (data.apis || []).filter(u => u.startsWith('https://'));
    invidiousApiCache = apis;
    invidiousApiCacheTime = Date.now();
    console.log(`Invidious API list cached: ${apis.length} instances`);
    return apis;
  } catch (e) {
    console.error('Invidious list fetch failed:', e.message);
    return invidiousApiCache || [];
  }
}

// Piped と同じパスを Invidious に投げるためのパス変換
// /trending?region=JP → /api/v1/trending?region=JP
// /search?q=...       → /api/v1/search?q=...
// /channel/UCxxx      → /api/v1/channels/UCxxx
// /comments/VIDEO_ID  → /api/v1/comments/VIDEO_ID
function pipedPathToInvidious(path) {
  if (path === '/trending') return '/api/v1/trending';
  if (path === '/search') return '/api/v1/search';
  if (path.startsWith('/channel/')) return '/api/v1/channels/' + path.slice('/channel/'.length);
  if (path.startsWith('/comments/')) return '/api/v1/comments/' + path.slice('/comments/'.length);
  if (path.startsWith('/streams/')) return '/api/v1/videos/' + path.slice('/streams/'.length);
  if (path.startsWith('/playlists/')) return '/api/v1/playlists/' + path.slice('/playlists/'.length);
  return '/api/v1' + path;
}

app.get('/invidious/*', async (req, res) => {
  const path = req.path.replace('/invidious', '');
  const invPath = pipedPathToInvidious(path);
  const query = new URLSearchParams(req.query).toString();
  const queryStr = query ? '?' + query : '';

  const apis = await getInvidiousApis();
  if (apis.length === 0) {
    return res.status(503).json({ error: 'No Invidious instances available' });
  }

  // 全インスタンスを並列で叩き、最初に成功したものを採用（Promise.any 風）
  // ただし fetch を全部走らせると負荷が高いので、先頭 N 件に絞る
  const candidates = apis.slice(0, 15);

  try {
    const result = await Promise.any(
      candidates.map(async (base) => {
        const url = `${base}${invPath}${queryStr}`;
        const r = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible; K-tube/1.0)'
          },
          signal: AbortSignal.timeout(8000) // 8秒タイムアウト
        });
        if (!r.ok) throw new Error(`${base} → ${r.status}`);
        const json = await r.json();
        return { base, json };
      })
    );

    console.log(`Invidious success: ${result.base}${invPath}`);
    res.setHeader('Content-Type', 'application/json');
    res.json(result.json);

  } catch (e) {
    console.error('All Invidious instances failed:', e.message);
    res.status(503).json({ error: 'All Invidious instances failed' });
  }
});

app.get("/download", async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).send("URL required");
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      console.error("Download fetch failed:", response.status);
      return res.status(response.status).send("Download fetch failed");
    }

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="video_360p.mp4"'
    );

    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") || "video/mp4"
    );

    response.body.pipe(res);

  } catch (err) {
    console.error("Download proxy error:", err);
    res.status(500).send("Download failed");
  }
});

// 統計取得API
app.get("/stats", async (req, res) => {
  // JSTでYYYY-MM-DDを作る
  const today = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })
  )
    .toISOString()
    .split("T")[0];

  const { data, error } = await supabase
    .from("access_stats")
    .select("*")
    .eq("date", today)
    .single();

  if (error || !data) {
    return res.json({
      total_views: 0,
      today_views: 0,
      online_now: 0
    });
  }

  const now = Date.now();
  let onlineCount = 0;

  for (const [ip, timestamp] of activeUsers.entries()) {
    if (now - timestamp <= ONLINE_TIMEOUT) {
      onlineCount++;
    } else {
      activeUsers.delete(ip);
    }
  }

  res.json({
    total_views: data.total_views,
    today_views: data.today_views,
    online_now: onlineCount
  });
});

app.get("/fake-views", async (req, res) => {
  try {
    const times = parseInt(req.query.times) || 1;

    for (let i = 0; i < times; i++) {
      await incrementAccesses();   // ← これ追加
    }

    res.json({
      success: true,
      added: times
    });

  } catch (err) {
    console.error("fake-views error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ====================== InnerTube ANDROID 字幕取得 ======================
const ANDROID_CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '19.44.38',  // 2026年時点の有効なバージョン例。切れたら yt-dlp のソースを参照して更新
  androidSdkVersion: 30,
  userAgent: 'com.google.android.youtube/19.44.38 (Linux; U; Android 11) gzip'
};

// visitorData を取得（ANDROID クライアントで LOGIN_REQUIRED を避けるために必要[citation:8]）
async function getVisitorData() {
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/next?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20260101.00.00' } } }),
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) throw new Error(`next ${res.status}`);
    const data = await res.json();
    return data?.responseContext?.visitorData || '';
  } catch (e) {
    console.warn('visitorData fetch failed:', e.message);
    return '';
  }
}

// InnerTube ANDROID で captionTracks を取得
async function fetchCaptionTracksAndroid(videoId) {
  const visitorData = await getVisitorData();

  const body = {
    context: {
      client: {
        clientName: ANDROID_CLIENT.clientName,
        clientVersion: ANDROID_CLIENT.clientVersion,
        androidSdkVersion: ANDROID_CLIENT.androidSdkVersion,
        hl: 'ja',
        gl: 'JP',
        visitorData: visitorData || undefined
      }
    },
    videoId
  };

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': ANDROID_CLIENT.userAgent,
    'X-YouTube-Client-Name': '3',
    'X-YouTube-Client-Version': ANDROID_CLIENT.clientVersion
  };
  if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

  const res = await fetch('https://www.youtube.com/youtubei/v1/player?key=AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });

  if (!res.ok) throw new Error(`player ${res.status}`);
  const data = await res.json();

  if (data?.playabilityStatus?.status !== 'OK') {
    throw new Error(`playability: ${data?.playabilityStatus?.reason || data?.playabilityStatus?.status}`);
  }

  const renderer = data?.captions?.playerCaptionsTracklistRenderer;
  return {
    captionTracks: renderer?.captionTracks || [],
    translationLanguages: renderer?.translationLanguages || []
  };
}

// ── 字幕リスト取得 ──
app.get('/captions/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const label = req.query.label;

  try {
    const { captionTracks } = await fetchCaptionTracksAndroid(videoId);

    // リスト返却
    if (!label) {
      const captions = captionTracks.map(t => ({
        label: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
        languageCode: t.languageCode,
        url: t.baseUrl,
        isAutoGenerated: t.kind === 'asr'
      }));
      return res.json({ captions });
    }

    // VTT 取得
    const track = captionTracks.find(t =>
      (t.name?.simpleText || t.name?.runs?.[0]?.text) === label ||
      t.languageCode === label
    );
    if (!track) return res.status(404).send('track not found');

    // ANDROID 経由では XML が返る場合があるため fmt=vtt を付与[citation:8]
    const vttUrl = track.baseUrl + '&fmt=vtt';
    const vttRes = await fetch(vttUrl, {
      headers: { 'User-Agent': ANDROID_CLIENT.userAgent },
      signal: AbortSignal.timeout(8000)
    });
    if (!vttRes.ok) throw new Error(`vtt ${vttRes.status}`);
    const vtt = await vttRes.text();
    if (!vtt || vtt.length < 20) throw new Error('empty vtt');

    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(vtt);
  } catch (e) {
    console.error('captions failed:', e.message);
    res.status(500).json({ error: 'captions failed', message: e.message });
  }
});

// ── 翻訳先言語リスト ──
app.get('/captions/:videoId/translate-langs', async (req, res) => {
  const { videoId } = req.params;
  try {
    const { translationLanguages } = await fetchCaptionTracksAndroid(videoId);
    const langs = translationLanguages.map(l => ({
      code: l.languageCode,
      name: l.languageName?.simpleText || l.languageName?.runs?.[0]?.text || l.languageCode
    }));
    res.json({ langs });
  } catch (e) {
    console.error('translate-langs failed:', e.message);
    res.status(500).json({ error: 'translate-langs failed' });
  }
});

// ── 翻訳字幕 VTT 取得 ──
app.get('/captions/:videoId/translate', async (req, res) => {
  const { videoId } = req.params;
  const tlang = req.query.tlang;
  if (!tlang) return res.status(400).send('tlang required');

  try {
    const { captionTracks } = await fetchCaptionTracksAndroid(videoId);
    if (captionTracks.length === 0) throw new Error('no caption tracks');

    // 最初のトラック（または自動生成）をベースに翻訳
    const base = captionTracks.find(t => t.kind === 'asr') || captionTracks[0];
    const vttUrl = base.baseUrl + `&tlang=${encodeURIComponent(tlang)}&fmt=vtt`;

    const vttRes = await fetch(vttUrl, {
      headers: { 'User-Agent': ANDROID_CLIENT.userAgent },
      signal: AbortSignal.timeout(8000)
    });
    if (!vttRes.ok) throw new Error(`translate vtt ${vttRes.status}`);
    const vtt = await vttRes.text();
    if (!vtt || vtt.length < 20) throw new Error('empty translate vtt');

    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(vtt);
  } catch (e) {
    console.error('translate failed:', e.message);
    res.status(500).send('translate failed');
  }
});


app.use("/Tools/Science", express.static("Tools/Science"));

app.all("/Tools/Science/proxy/*", async (req, res) => {
  try {
    const raw = req.params[0]
    const targetUrl = decodeURIComponent(raw)
    const urlObj = new URL(targetUrl)

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        "user-agent": req.headers["user-agent"] || "",
        "cookie": req.headers["cookie"] || "",
        "content-type": req.headers["content-type"] || "",
        "authorization": req.headers["authorization"] || "",
        "accept": req.headers["accept"] || "",
        "accept-language": req.headers["accept-language"] || "",
        "referer": urlObj.origin
      },
      body: ["GET", "HEAD"].includes(req.method)
        ? undefined
        : JSON.stringify(req.body),
      redirect: "manual"
    })

    //  リダイレクト対応
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (location) {
        const absolute = new URL(location, targetUrl).href
        return res.redirect("/Tools/Science/proxy/" + encodeURIComponent(absolute))
      }
    }

    const contentType = response.headers.get("content-type") || ""

    //  cookie返却
    const setCookie = response.headers.raw()["set-cookie"]
    if (setCookie) {
      res.setHeader("set-cookie", setCookie)
    }

    //  バイナリ対応
    const isText =
      contentType.includes("text") ||
      contentType.includes("javascript") ||
      contentType.includes("json")

    if (!isText) {
      const buffer = await response.arrayBuffer()
      res.setHeader("content-type", contentType)
      return res.send(Buffer.from(buffer))
    }

    let body = await response.text()

    // =========================
    // HTML処理
    // =========================
    if (contentType.includes("text/html")) {
      const base = `/Tools/Science/proxy/${encodeURIComponent(targetUrl)}`
      body = body.replace("<head>", `<head><base href="${base}">`)

      const inject = `
<script>
(function(){
const proxy = (url) => "/Tools/Science/proxy/" + encodeURIComponent(url);

// =================
// fetch
// =================
const originalFetch = window.fetch;
window.fetch = function(input, init){
  try{
    let url = typeof input === "object" ? input.url : input;
    const absolute = new URL(url, location.href).href;
    const proxied = proxy(absolute);

    if(typeof input === "object"){
      input = new Request(proxied, input);
    } else {
      input = proxied;
    }
  }catch(e){}
  return originalFetch(input, init);
};

// =================
// XHR
// =================
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url){
  try{
    const absolute = new URL(url, location.href).href;
    url = proxy(absolute);
  }catch(e){}
  return open.call(this, method, url);
};

// =================
// location制御
// =================
const assign = window.location.assign;
window.location.assign = function(url){
  try{
    const absolute = new URL(url, location.href).href;
    url = proxy(absolute);
  }catch(e){}
  return assign.call(this, url);
};

const replace = window.location.replace;
window.location.replace = function(url){
  try{
    const absolute = new URL(url, location.href).href;
    url = proxy(absolute);
  }catch(e){}
  return replace.call(this, url);
};

// =================
// aタグ強制
// =================
document.addEventListener("click", function(e){
  const a = e.target.closest("a");
  if(!a) return;

  const href = a.getAttribute("href");
  if(!href || href.startsWith("javascript:")) return;

  try{
    const absolute = new URL(href, location.href).href;
    a.href = proxy(absolute);
  }catch(e){}
});

// =================
// form強制
// =================
document.addEventListener("submit", function(e){
  const form = e.target;
  if(!form.action) return;

  try{
    const absolute = new URL(form.action, location.href).href;
    form.action = proxy(absolute);
  }catch(e){}
});

// =================
// WebSocket
// =================
const WS = window.WebSocket;
window.WebSocket = function(url, protocols){
  try{
    const absolute = new URL(url, location.href).href;
    url = proxy(absolute);
  }catch(e){}
  return new WS(url, protocols);
};

})();
</script>
`

      body = body.replace("</head>", inject + "</head>")

      //  リンク書き換え
      body = body.replace(/(src|href)=["'](.*?)["']/gi, (m, attr, link) => {
        try {
          if (link.startsWith("data:") || link.startsWith("javascript:")) return m
          const absolute = new URL(link, targetUrl).href
          return attr + '="/Tools/Science/proxy/' + encodeURIComponent(absolute) + '"'
        } catch {
          return m
        }
      })

      // iframe制限
      body = body.replace(/<iframe/gi, '<iframe sandbox="allow-scripts allow-forms"')
    }

    // CSP解除＆再設定
    res.removeHeader("content-security-policy")
    res.removeHeader("x-frame-options")

    res.setHeader(
      "content-security-policy",
      "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'"
    )

    res.setHeader("content-type", contentType)
    res.send(body)

  } catch (e) {
    console.error(e)
    res.status(500).send("proxy error")
  }
})


// 最後にサーバー起動
app.listen(PORT, () => {
  console.log(`K-tube Server running on port ${PORT}`);
});
