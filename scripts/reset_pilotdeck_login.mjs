#!/usr/bin/env node
/**
 * 重置本地 PilotDeck 登录账号（~/.pilotdeck/auth.db 的 users 表）。
 *
 * 用法:
 *   node scripts/reset_pilotdeck_login.mjs [用户名] [密码]
 *   node scripts/reset_pilotdeck_login.mjs            # 交互式输入
 *
 * 环境变量（换机器/换路径时用）:
 *   PILOTDECK_AUTH_DB   auth.db 路径
 *   PILOTDECK_APP_UI    PilotDeck UI 目录，用来解析 bcrypt / better-sqlite3
 *   PILOTDECK_RENAME_FROM  把某个旧用户名的行改成目标用户名（统一账号时用）
 *
 * 注意: node 必须是「跑服务端那个」版本，better-sqlite3 是原生模块，
 * 换版本会报 NODE_MODULE_VERSION 不匹配。
 *
 * 行为:
 *   1. 先把 auth.db 备份成 auth.db.bak.<时间戳>
 *   2. 用 PilotDeck 自带的 bcrypt（cost 12，和注册流程一致）算哈希
 *   3. 若用户名已存在就原地更新，否则插入
 *   4. 写完立刻用 bcrypt.compare 回读校验，不通就报错退出
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createRequire } from 'node:module';

const APP_UI = process.env.PILOTDECK_APP_UI || '/home/marc/.pilotdeck/app/ui';
const DB_PATH = process.env.PILOTDECK_AUTH_DB || '/home/marc/.pilotdeck/auth.db';
const SALT_ROUNDS = 12;

const require = createRequire(`${APP_UI}/server/index.js`);
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
}

async function main() {
  let [username, password] = process.argv.slice(2);

  if (!username || !password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    username = username || (await rl.question('用户名: ')).trim();
    password = password || (await rl.question('密码: '));
    rl.close();
  }

  if (!username.trim() || !password) {
    console.error('用户名和密码都不能为空');
    process.exit(1);
  }
  username = username.trim();

  // 1. 备份
  const backup = `${DB_PATH}.bak.${stamp()}`;
  fs.copyFileSync(DB_PATH, backup, fs.constants.COPYFILE_FICLONE);
  console.log(`已备份 -> ${backup}`);

  // 2. 哈希
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  // 3. 写入
  const db = new Database(DB_PATH);
  try {
    db.pragma('busy_timeout = 5000');
    const from = (process.env.PILOTDECK_RENAME_FROM || '').trim();
    if (from && from !== username) {
      // 统一账号：把旧用户名的行原地改名，避免留下两个能登录的账号
      const renamed = db.prepare('SELECT id FROM users WHERE username = ?').get(from);
      if (renamed) {
        const clash = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        if (clash) {
          throw new Error(`用户名 ${username} 已存在（#${clash.id}），无法把 ${from} 改名过来`);
        }
        db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, renamed.id);
        console.log(`已把用户 ${from} (#${renamed.id}) 改名为 ${username}`);
      } else {
        console.log(`跳过改名：没有叫 ${from} 的用户`);
      }
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      db.prepare(
        'UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?'
      ).run(passwordHash, existing.id);
      console.log(`已更新用户 #${existing.id} (${username})`);
    } else {
      const info = db.prepare(
        'INSERT INTO users (username, password_hash, is_active) VALUES (?, ?, 1)'
      ).run(username, passwordHash);
      console.log(`已新建用户 #${info.lastInsertRowid} (${username})`);
    }
  } finally {
    db.close();
  }

  // 4. 回读校验：走的正是后端那条查询语句
  const verify = new Database(DB_PATH, { readonly: true });
  let row;
  try {
    row = verify
      .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
      .get(username);
  } finally {
    verify.close();
  }

  const ok = row && (await bcrypt.compare(password, row.password_hash));
  console.log(`校验: ${ok ? 'OK — 密码可验证通过' : '失败'}`);
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error('重置失败:', error.message);
  process.exit(1);
});
