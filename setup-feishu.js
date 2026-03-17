/**
 * 飞书多维表格初始化脚本
 * 自动创建 notes / review_records 两张表及全部字段，并更新 .env
 */
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const APP_TOKEN = process.env.FEISHU_BASE_APP_TOKEN;
const APP_ID    = process.env.FEISHU_APP_ID;
const APP_SECRET= process.env.FEISHU_APP_SECRET;

// 字段类型常量
const TYPE = { TEXT: 1, NUMBER: 2, DATE: 5, CHECKBOX: 7 };

// ——— 获取 tenant_access_token ———
async function getToken() {
  const r = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: APP_ID, app_secret: APP_SECRET
  });
  if (r.data.code !== 0) throw new Error('获取 Token 失败：' + r.data.msg);
  return r.data.tenant_access_token;
}

function headers(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// ——— 获取已有表列表 ———
async function listTables(token) {
  const r = await axios.get(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables`,
    { headers: headers(token) }
  );
  if (r.data.code !== 0) throw new Error('获取表列表失败：' + r.data.msg);
  return r.data.data.items || [];
}

// ——— 创建新表 ———
async function createTable(token, name) {
  const r = await axios.post(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables`,
    { table: { name } },
    { headers: headers(token) }
  );
  if (r.data.code !== 0) throw new Error(`创建表 ${name} 失败：` + r.data.msg);
  return r.data.data.table_id;
}

// ——— 获取已有字段 ———
async function listFields(token, tableId) {
  const r = await axios.get(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`,
    { headers: headers(token) }
  );
  if (r.data.code !== 0) throw new Error('获取字段列表失败：' + r.data.msg);
  return (r.data.data.items || []).map(f => f.field_name);
}

// ——— 添加单个字段 ———
async function addField(token, tableId, fieldName, fieldType, extra = {}) {
  const body = { field_name: fieldName, type: fieldType, ...extra };
  const r = await axios.post(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`,
    body,
    { headers: headers(token) }
  );
  if (r.data.code !== 0) {
    console.warn(`  ⚠ 字段 "${fieldName}" 添加失败：${r.data.msg}`);
  } else {
    console.log(`  ✅ 字段 "${fieldName}" 创建成功`);
  }
}

// ——— 确保字段存在（跳过已有字段）———
async function ensureFields(token, tableId, fields) {
  const existing = await listFields(token, tableId);
  for (const [name, type, extra] of fields) {
    if (existing.includes(name)) {
      console.log(`  ↩ 字段 "${name}" 已存在，跳过`);
    } else {
      await addField(token, tableId, name, type, extra || {});
    }
  }
}

// ——— 更新 .env ———
function updateEnv(notesId, reviewId) {
  const envPath = path.join(__dirname, '.env');
  let content = fs.readFileSync(envPath, 'utf8');
  content = content.replace(/FEISHU_NOTES_TABLE_ID=.*/,   `FEISHU_NOTES_TABLE_ID=${notesId}`);
  content = content.replace(/FEISHU_REVIEW_TABLE_ID=.*/, `FEISHU_REVIEW_TABLE_ID=${reviewId}`);
  fs.writeFileSync(envPath, content, 'utf8');
  console.log('\n📝 .env 已更新');
}

// ——— 主流程 ———
async function main() {
  console.log('🚀 开始初始化飞书多维表格…\n');
  const token = await getToken();
  console.log('✅ 获取 token 成功\n');

  // 1. 查看已有表
  const tables = await listTables(token);
  console.log(`当前表格列表：${tables.map(t => `${t.name}(${t.table_id})`).join(' | ') || '（空）'}\n`);

  // 2. notes 表：如果已有第一张表就用它，否则新建
  let notesId = process.env.FEISHU_NOTES_TABLE_ID;
  let notesExists = tables.find(t => t.table_id === notesId);
  if (!notesExists) {
    const existNotes = tables.find(t => t.name === 'notes');
    if (existNotes) {
      notesId = existNotes.table_id;
      console.log(`📋 找到已有 notes 表：${notesId}`);
    } else if (tables.length > 0) {
      // 用第一张表作为 notes 表（重命名）
      notesId = tables[0].table_id;
      console.log(`📋 使用现有第一张表作为 notes 表：${notesId}`);
    } else {
      console.log('📋 创建 notes 表…');
      notesId = await createTable(token, 'notes');
      console.log(`   表 ID：${notesId}`);
    }
  } else {
    console.log(`📋 notes 表已存在：${notesId}`);
  }

  // 3. review_records 表
  let reviewId = process.env.FEISHU_REVIEW_TABLE_ID;
  const existReview = tables.find(t => t.name === 'review_records' || t.table_id === reviewId);
  if (existReview && existReview.table_id !== 'your_review_records_table_id') {
    reviewId = existReview.table_id;
    console.log(`\n📋 review_records 表已存在：${reviewId}`);
  } else {
    console.log('\n📋 创建 review_records 表…');
    reviewId = await createTable(token, 'review_records');
    console.log(`   表 ID：${reviewId}`);
  }

  // 4. 添加 notes 字段
  console.log('\n🛠  配置 notes 表字段…');
  await ensureFields(token, notesId, [
    ['note_id', TYPE.TEXT],
    ['date',    TYPE.DATE, { property: { date_formatter: 'yyyy/MM/dd' } }],
    ['words',   TYPE.TEXT],
    ['phrases', TYPE.TEXT],
    ['sentences', TYPE.TEXT],
  ]);

  // 5. 添加 review_records 字段
  console.log('\n🛠  配置 review_records 表字段…');
  await ensureFields(token, reviewId, [
    ['note_id',        TYPE.TEXT],
    ['day_offset',     TYPE.NUMBER],
    ['scheduled_date', TYPE.DATE, { property: { date_formatter: 'yyyy/MM/dd' } }],
    ['completed',      TYPE.CHECKBOX],
    ['result',         TYPE.TEXT],
  ]);

  // 6. 更新 .env
  updateEnv(notesId, reviewId);

  console.log('\n🎉 初始化完成！');
  console.log(`   FEISHU_NOTES_TABLE_ID   = ${notesId}`);
  console.log(`   FEISHU_REVIEW_TABLE_ID  = ${reviewId}`);
  console.log('\n现在可以运行：npm run dev');
}

main().catch(e => {
  console.error('\n❌ 错误：', e.response?.data || e.message);
  process.exit(1);
});
