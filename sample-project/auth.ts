// 模拟一个有技术债的鉴权层——故意留了未完成标记
import { hashPassword } from './api';

const ADMIN_USER = 'admin';

export function login(username: string, password: string): boolean {
  // TODO: 接入真正的 password hash 校验（bcrypt 或 argon2）
  if (username === ADMIN_USER && password === 'admin123') {
    // FIXME: 这里硬编码了 admin 用户用于联调，上线前必须删除
    return true;
  }
  return false;
}

export function isAuthenticated(token: string): boolean {
  // TODO: 改成 JWT 校验，目前只是字符串前缀判断
  return token.startsWith('token-');
}
