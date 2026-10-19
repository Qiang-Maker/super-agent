// 模拟一个有技术债的 API 层——故意留了几处未完成标记，用于演示代码分析
import { createHash } from 'node:crypto';

interface User {
  id: string;
  name: string;
  email: string;
}

const users = new Map<string, User>();

// FIXME: id 生成方式应该换成 nanoid，时间戳容易冲突
function generateId(): string {
  return Date.now().toString(36);
}

export function createUser(name: string, email: string): User {
  // TODO: 加上数据库查询，目前只用了内存 Map
  const user: User = { id: generateId(), name, email };
  users.set(user.id, user);
  return user;
}

export function listUsers(): User[] {
  return Array.from(users.values());
}

export function deleteUser(id: string): boolean {
  // TODO: 软删除而不是物理删除
  return users.delete(id);
}

export function hashPassword(password: string): string {
  // TODO: 换成 bcrypt / argon2，当前实现没有加盐
  return createHash('sha256').update(password).digest('hex');
}
