/**
 * 飞书 notes 表迁移脚本
 * 将旧 schema（每行存 JSON 数组）迁移到新 schema（每行存一个词汇）
 */
require('dotenv').config();
const axios = require('axios');

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const APP_TOKEN = process.env.FEISHU_BASE_APP_TOKEN;
const NOTES_TABLE_ID = process.env.FEISHU_NOTES_TABLE_ID;

async function getToken() {
  const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: APP_ID, app_secret: APP_SECRET
  });
  return res.data.tenant_access_token;
}

function headers(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function getAllRecords(token, tableId) {
  let records = [], pageToken = '';
  while (true) {
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`;
    const r = await axios.get(url, { headers: headers(token) });
    records = records.concat(r.data.data.items || []);
    if (!r.data.data.has_more) break;
    pageToken = r.data.data.page_token;
  }
  return records;
}

async function deleteRecord(token, tableId, recordId) {
  await axios.delete(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/${recordId}`,
    { headers: headers(token) }
  );
}

async function getFields(token, tableId) {
  const r = await axios.get(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`,
    { headers: headers(token) }
  );
  return r.data.data.items || [];
}

async function deleteField(token, tableId, fieldId) {
  try {
    await axios.delete(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields/${fieldId}`,
      { headers: headers(token) }
    );
  } catch (e) {
    console.log(`  删除字段失败（可能是主字段）: ${e.response?.data?.msg}`);
  }
}

async function createField(token, tableId, name, type, extra = {}) {
  const body = { field_name: name, type, ...extra };
  const r = await axios.post(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`,
    body,
    { headers: headers(token) }
  );
  if (r.data.code !== 0) {
    console.log(`  创建字段 ${name} 失败: ${r.data.msg}`);
    return null;
  }
  return r.data.data?.field?.field_id;
}

async function renameField(token, tableId, fieldId, name, type) {
  const r = await axios.put(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields/${fieldId}`,
    { field_name: name, type },
    { headers: headers(token) }
  );
  return r.data.code === 0;
}

async function main() {
  console.log('🚀 开始迁移 notes 表 schema...\n');
  const token = await getToken();

  // 1. 清空旧记录
  console.log('Step 1: 清空旧记录...');
  const oldRecords = await getAllRecords(token, NOTES_TABLE_ID);
  console.log(`  发现 ${oldRecords.length} 条旧记录，正在删除...`);
  for (const rec of oldRecords) {
    await deleteRecord(token, NOTES_TABLE_ID, rec.record_id);
  }
  console.log('  ✅ 旧记录已清空\n');

  // 2. 查看现有字段
  console.log('Step 2: 查看现有字段...');
  const fields = await getFields(token, NOTES_TABLE_ID);
  console.log('  现有字段:', fields.map(f => `${f.field_name}(${f.field_id},type:${f.type})`).join(', '));

  // 找到主字段（type=1, 通常是第一个）
  const primaryField = fields.find(f => f.is_primary) || fields[0];
  const nonPrimaryFields = fields.filter(f => f.field_id !== primaryField?.field_id);

  // 3. 重命名主字段为 word
  console.log('\nStep 3: 重命名主字段为 word...');
  if (primaryField) {
    const ok = await renameField(token, NOTES_TABLE_ID, primaryField.field_id, 'word', 1);
    console.log(ok ? '  ✅ 主字段已命名为 word' : '  ⚠️ 命名失败，继续...');
  }

  // 4. 删除旧的非主字段
  console.log('\nStep 4: 删除旧字段...');
  for (const f of nonPrimaryFields) {
    console.log(`  删除字段: ${f.field_name}`);
    await deleteField(token, NOTES_TABLE_ID, f.field_id);
  }
  console.log('  ✅ 旧字段已清理\n');

  // 5. 创建新字段
  console.log('Step 5: 创建新字段...');
  const newFields = [
    { name: 'translation', type: 1 },   // 文本
    { name: 'type', type: 1 },           // 文本（word/phrase/sentence）
    { name: 'synonym', type: 1 },        // 文本
    { name: 'date', type: 5 },           // 日期
    { name: 'group_id', type: 1 },       // 文本
  ];

  for (const f of newFields) {
    const fieldId = await createField(token, NOTES_TABLE_ID, f.name, f.type);
    if (fieldId) {
      console.log(`  ✅ 创建字段: ${f.name}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n✅ notes 表迁移完成！');
  console.log('📋 新字段结构：');
  console.log('   word        - 英文单词/短语/例句（主字段）');
  console.log('   translation - 中文释义');
  console.log('   type        - 类型（word/phrase/sentence）');
  console.log('   synonym     - 近义词（选填）');
  console.log('   date        - 添加日期');
  console.log('   group_id    - 同一次上传的分组 ID\n');
}

main().catch(e => {
  console.error('❌ 迁移失败:', e.response?.data || e.message);
  process.exit(1);
});
