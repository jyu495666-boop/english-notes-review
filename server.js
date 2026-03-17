require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// multer 用于处理图片上传
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ==============================
// 飞书 Token 管理
// ==============================
let feishuToken = null;
let tokenExpireAt = 0;

async function getFeishuToken() {
  if (feishuToken && Date.now() < tokenExpireAt) {
    return feishuToken;
  }
  const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: process.env.FEISHU_APP_ID,
    app_secret: process.env.FEISHU_APP_SECRET
  });
  feishuToken = res.data.tenant_access_token;
  tokenExpireAt = Date.now() + (res.data.expire - 60) * 1000;
  return feishuToken;
}

function feishuHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

// ==============================
// API 路由：OCR + 结构化解析
// ==============================
app.post('/api/ocr', upload.single('image'), async (req, res) => {
  try {
    let base64Image;
    if (req.file) {
      base64Image = req.file.buffer.toString('base64');
    } else if (req.body.imageBase64) {
      base64Image = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
    } else {
      return res.status(400).json({ error: '请提供图片文件或 base64 数据' });
    }

    const mimeType = req.file ? req.file.mimetype : 'image/jpeg';

    // Step 1: DeepSeek Vision OCR —— 识别图片内容
    const ocrRes = await axios.post('https://api.deepseek.com/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64Image}` }
            },
            {
              type: 'text',
              text: `请识别这张英语学习笔记图片中的所有内容，以纯文本形式输出，保留原有的结构和分组。`
            }
          ]
        }
      ],
      max_tokens: 2000
    }, {
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const ocrText = ocrRes.data.choices[0].message.content;

    // Step 2: DeepSeek Chat —— 结构化解析为 JSON
    const parseRes = await axios.post('https://api.deepseek.com/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `你是英语学习助手。请将用户提供的英语笔记文本解析成结构化 JSON。
输出格式（严格 JSON，不加代码块）：
{
  "words": [{"en": "英文单词", "cn": "中文释义", "synonym": "近义词（可空）"}],
  "phrases": [{"en": "英文短语", "cn": "中文释义"}],
  "sentences": [{"en": "英文例句", "cn": "中文翻译", "blank_word": "填空考察的单词（可空）"}]
}
如果某类为空，对应数组返回 []。`
        },
        {
          role: 'user',
          content: `请解析以下英语笔记：\n\n${ocrText}`
        }
      ],
      max_tokens: 3000
    }, {
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    let parsed;
    try {
      let jsonStr = parseRes.data.choices[0].message.content.trim();
      // 去掉可能的 markdown 代码块
      jsonStr = jsonStr.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      parsed = { words: [], phrases: [], sentences: [], raw: parseRes.data.choices[0].message.content };
    }

    res.json({ success: true, ocrText, parsed });
  } catch (error) {
    console.error('OCR 错误:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.error?.message || error.message });
  }
});

// ==============================
// API 路由：笔记 CRUD（飞书）
// ==============================

// 获取所有笔记
app.get('/api/notes', async (req, res) => {
  try {
    const token = await getFeishuToken();
    const appToken = process.env.FEISHU_BASE_APP_TOKEN;
    const tableId = process.env.FEISHU_NOTES_TABLE_ID;

    let allRecords = [];
    let pageToken = '';
    while (true) {
      const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`;
      const r = await axios.get(url, { headers: feishuHeaders(token) });
      const data = r.data.data;
      allRecords = allRecords.concat(data.items || []);
      if (!data.has_more) break;
      pageToken = data.page_token;
    }

    const notes = allRecords.map(item => ({
      id: item.record_id,
      note_id: item.fields.note_id || '',
      date: item.fields.date || '',
      words: safeParseJSON(item.fields.words),
      phrases: safeParseJSON(item.fields.phrases),
      sentences: safeParseJSON(item.fields.sentences),
      image_url: item.fields.image_url || ''
    }));

    res.json({ success: true, notes });
  } catch (error) {
    console.error('获取笔记错误:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.msg || error.message });
  }
});

// 创建新笔记
app.post('/api/notes', async (req, res) => {
  try {
    const token = await getFeishuToken();
    const appToken = process.env.FEISHU_BASE_APP_TOKEN;
    const tableId = process.env.FEISHU_NOTES_TABLE_ID;

    const { note_id, date, words, phrases, sentences } = req.body;

    const fields = {
      note_id: note_id || `N${Date.now()}`,
      date: date || new Date().toISOString().split('T')[0],
      words: JSON.stringify(words || []),
      phrases: JSON.stringify(phrases || []),
      sentences: JSON.stringify(sentences || [])
    };

    const r = await axios.post(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      { fields },
      { headers: feishuHeaders(token) }
    );

    // 自动创建复习计划
    await createReviewSchedule(token, fields.note_id, fields.date);

    res.json({ success: true, record_id: r.data.data.record.record_id, note_id: fields.note_id });
  } catch (error) {
    console.error('创建笔记错误:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.msg || error.message });
  }
});

// ==============================
// API 路由：复习记录
// ==============================

// 获取今日复习任务
app.get('/api/review/today', async (req, res) => {
  try {
    const token = await getFeishuToken();
    const appToken = process.env.FEISHU_BASE_APP_TOKEN;
    const tableId = process.env.FEISHU_REVIEW_TABLE_ID;

    const today = getTodayStr();
    let allRecords = [];
    let pageToken = '';
    while (true) {
      const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`;
      const r = await axios.get(url, { headers: feishuHeaders(token) });
      const data = r.data.data;
      allRecords = allRecords.concat(data.items || []);
      if (!data.has_more) break;
      pageToken = data.page_token;
    }

    const todayTasks = allRecords
      .filter(item => {
        const scheduled = item.fields.scheduled_date || '';
        const completed = item.fields.completed;
        return scheduled === today && !completed;
      })
      .map(item => ({
        id: item.record_id,
        note_id: item.fields.note_id,
        day_offset: item.fields.day_offset,
        scheduled_date: item.fields.scheduled_date
      }));

    res.json({ success: true, tasks: todayTasks });
  } catch (error) {
    console.error('获取复习任务错误:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.msg || error.message });
  }
});

// 完成复习
app.post('/api/review/complete', async (req, res) => {
  try {
    const token = await getFeishuToken();
    const appToken = process.env.FEISHU_BASE_APP_TOKEN;
    const tableId = process.env.FEISHU_REVIEW_TABLE_ID;

    const { record_id, result } = req.body;

    await axios.put(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${record_id}`,
      { fields: { completed: true, result: result || 'ok' } },
      { headers: feishuHeaders(token) }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('完成复习错误:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.msg || error.message });
  }
});

// ==============================
// API 路由：飞书机器人通知
// ==============================
app.post('/api/notify', async (req, res) => {
  try {
    const { message } = req.body;
    const webhookUrl = process.env.FEISHU_WEBHOOK_URL;

    if (!webhookUrl || webhookUrl.includes('your_webhook_token')) {
      return res.json({ success: false, message: '飞书 Webhook 未配置' });
    }

    await axios.post(webhookUrl, {
      msg_type: 'text',
      content: { text: message || '📚 今日英语复习提醒：您有待复习的笔记！' }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('飞书通知错误:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.msg || error.message });
  }
});

// ==============================
// API 路由：定时任务触发接口（供 cron-job.org 调用）
// ==============================
app.get('/api/cron/notify', async (req, res) => {
  try {
    const webhookUrl = process.env.FEISHU_WEBHOOK_URL;
    if (!webhookUrl || webhookUrl.includes('your_webhook_token')) {
      return res.json({ success: false, message: '飞书 Webhook 未配置' });
    }

    const token = await getFeishuToken();
    const appToken = process.env.FEISHU_BASE_APP_TOKEN;
    const session = req.query.session || 'morning';

    // 北京时间今日日期
    const now = new Date();
    const bjNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const today = bjNow.toISOString().split('T')[0];

    // ---------- 早上提醒 ----------
    if (session === 'morning') {
      const reviewRecords = await fetchAllRecords(token, appToken, process.env.FEISHU_REVIEW_TABLE_ID);
      const pending = reviewRecords.filter(r => r.fields.scheduled_date === today && !r.fields.completed).length;

      const text = pending > 0
        ? `🌅 早上好！今天有 ${pending} 条笔记待复习\n💪 加油，坚持每天复习！\n👉 ${process.env.APP_URL || 'https://english-notes-review.onrender.com'}`
        : `🌅 早上好！今天没有复习任务\n🎉 你的笔记都已复习完毕，继续保持！`;

      await sendFeishuText(webhookUrl, text);
      return res.json({ success: true, pending });
    }

    // ---------- 晚上提醒（有未完成才发）----------
    if (session === 'evening') {
      const reviewRecords = await fetchAllRecords(token, appToken, process.env.FEISHU_REVIEW_TABLE_ID);
      const pending = reviewRecords.filter(r => r.fields.scheduled_date === today && !r.fields.completed).length;

      if (pending === 0) {
        return res.json({ success: true, sent: false, message: '今日已全部完成' });
      }

      const text = `🌙 晚上提醒：今天还有 ${pending} 条笔记未复习\n趁睡前完成吧～\n👉 ${process.env.APP_URL || 'https://english-notes-review.onrender.com'}`;
      await sendFeishuText(webhookUrl, text);
      return res.json({ success: true, pending });
    }

    // ---------- 周报（每周日 23:00）----------
    if (session === 'weekly') {
      const noteRecords = await fetchAllRecords(token, appToken, process.env.FEISHU_NOTES_TABLE_ID);
      const reviewRecords = await fetchAllRecords(token, appToken, process.env.FEISHU_REVIEW_TABLE_ID);

      // 本周范围（周一到今天）
      const weekStart = new Date(bjNow);
      weekStart.setDate(bjNow.getDate() - bjNow.getDay() + 1);
      const weekStartStr = weekStart.toISOString().split('T')[0];

      const newNotes = noteRecords.filter(r => (r.fields.date || '') >= weekStartStr);
      const weekReviews = reviewRecords.filter(r => (r.fields.scheduled_date || '') >= weekStartStr);
      const completed = weekReviews.filter(r => r.fields.completed);
      const okCount = completed.filter(r => r.fields.result === 'ok').length;
      const wrongCount = completed.filter(r => r.fields.result === 'wrong').length;
      const unknownCount = completed.filter(r => r.fields.result === 'unknown').length;
      const rate = completed.length > 0 ? Math.round((okCount / completed.length) * 100) : 0;

      // 本周新增词汇统计
      let totalWords = 0, totalPhrases = 0;
      newNotes.forEach(n => {
        totalWords += safeParseJSON(n.fields.words).length;
        totalPhrases += safeParseJSON(n.fields.phrases).length;
      });

      const text = [
        `📊 本周学习周报（${weekStartStr} ~ ${today}）`,
        ``,
        `📖 新增笔记：${newNotes.length} 条`,
        `   📝 单词：${totalWords} 个  💬 短语：${totalPhrases} 个`,
        ``,
        `🔁 复习情况：`,
        `   完成 ${completed.length} / ${weekReviews.length} 条`,
        `   ✅ 知道：${okCount}  ❌ 记错：${wrongCount}  ❓ 不认识：${unknownCount}`,
        `   🎯 正确率：${rate}%`,
        ``,
        rate >= 80 ? `🌟 本周表现优秀，继续冲！` :
        rate >= 60 ? `💪 本周还不错，下周继续加油！` :
                    `📚 本周有些遗忘，多复习几次吧～`,
      ].join('\n');

      await sendFeishuText(webhookUrl, text);
      return res.json({ success: true, type: 'weekly', newNotes: newNotes.length, rate });
    }

    res.json({ success: false, message: '未知 session 类型' });
  } catch (error) {
    console.error('定时通知错误:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.msg || error.message });
  }
});

// ==============================
// API 路由：复习完成后发到飞书（由前端调用）
// ==============================
app.post('/api/notify/complete', async (req, res) => {
  try {
    const webhookUrl = process.env.FEISHU_WEBHOOK_URL;
    if (!webhookUrl || webhookUrl.includes('your_webhook_token')) {
      return res.json({ success: false });
    }

    const token = await getFeishuToken();
    const appToken = process.env.FEISHU_BASE_APP_TOKEN;

    const now = new Date();
    const bjNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const today = bjNow.toISOString().split('T')[0];

    // 获取今日已完成的复习记录
    const reviewRecords = await fetchAllRecords(token, appToken, process.env.FEISHU_REVIEW_TABLE_ID);
    const todayDone = reviewRecords.filter(r => r.fields.scheduled_date === today && r.fields.completed);

    if (todayDone.length === 0) {
      return res.json({ success: false, message: '无今日完成记录' });
    }

    // 收集复习了哪些笔记，获取单词/短语内容
    const noteIds = [...new Set(todayDone.map(r => r.fields.note_id).filter(Boolean))];
    const noteRecords = await fetchAllRecords(token, appToken, process.env.FEISHU_NOTES_TABLE_ID);
    const targetNotes = noteRecords.filter(n => noteIds.includes(n.fields.note_id));

    let wordLines = [], phraseLines = [];
    targetNotes.forEach(n => {
      safeParseJSON(n.fields.words).forEach(w => {
        if (w.en) wordLines.push(`  • ${w.en}　${w.cn || ''}${w.synonym ? `（近义：${w.synonym}）` : ''}`);
      });
      safeParseJSON(n.fields.phrases).forEach(p => {
        if (p.en) phraseLines.push(`  • ${p.en}　${p.cn || ''}`);
      });
    });

    // 鼓励语随机
    const encouragements = [
      '太棒了！今天的复习任务全部完成 🎉',
      '坚持就是胜利！又完成了一天的学习 💪',
      '学习使我快乐！今天的词汇已入脑 🧠',
      '每天一点点积累，英语越来越好 🌱',
      '不积跬步，无以至千里。今天做到了！✨',
    ];
    const cheer = encouragements[Math.floor(Math.random() * encouragements.length)];

    const lines = [cheer, ''];
    if (wordLines.length > 0) {
      lines.push(`📖 今日复习单词（${wordLines.length} 个）：`);
      lines.push(...wordLines.slice(0, 20));
      if (wordLines.length > 20) lines.push(`  ... 共 ${wordLines.length} 个`);
    }
    if (phraseLines.length > 0) {
      lines.push('');
      lines.push(`💬 今日复习短语（${phraseLines.length} 个）：`);
      lines.push(...phraseLines.slice(0, 10));
      if (phraseLines.length > 10) lines.push(`  ... 共 ${phraseLines.length} 个`);
    }

    await sendFeishuText(webhookUrl, lines.join('\n'));
    res.json({ success: true });
  } catch (error) {
    console.error('完成通知错误:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.msg || error.message });
  }
});

// ==============================
// 工具函数
// ==============================
function safeParseJSON(str) {
  if (!str) return [];
  if (Array.isArray(str)) return str;
  try { return JSON.parse(str); } catch { return []; }
}

async function fetchAllRecords(token, appToken, tableId) {
  let allRecords = [];
  let pageToken = '';
  while (true) {
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`;
    const r = await axios.get(url, { headers: feishuHeaders(token) });
    const data = r.data.data;
    allRecords = allRecords.concat(data.items || []);
    if (!data.has_more) break;
    pageToken = data.page_token;
  }
  return allRecords;
}

async function sendFeishuText(webhookUrl, text) {
  await axios.post(webhookUrl, { msg_type: 'text', content: { text } });
}

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

async function createReviewSchedule(token, noteId, dateStr) {
  const appToken = process.env.FEISHU_BASE_APP_TOKEN;
  const tableId = process.env.FEISHU_REVIEW_TABLE_ID;

  const REVIEW_DAYS = [1, 3, 7, 15, 30];
  const records = REVIEW_DAYS.map(d => ({
    fields: {
      note_id: noteId,
      day_offset: d,
      scheduled_date: addDays(dateStr, d),
      completed: false,
      result: ''
    }
  }));

  // 批量创建复习记录
  await axios.post(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
    { records },
    { headers: feishuHeaders(token) }
  );
}

// ==============================
// 启动服务器
// ==============================
app.listen(PORT, () => {
  console.log(`\n🚀 英语笔记复习助手已启动`);
  console.log(`   本地访问：http://localhost:${PORT}`);
  console.log(`   按 Ctrl+C 停止\n`);
});
