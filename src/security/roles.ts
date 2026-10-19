/**
 * ============================================================================
 * 三级角色权限
 * ============================================================================
 *
 * 一旦把 Agent 暴露给别人（比如飞书群里任何人 @Bot），"谁能做什么"就必须解决。
 * 三个角色够用：
 *   owner        所有工具（终端里自己用，默认就是它）
 *   collaborator 所有工具但禁 bash（bash 能干的事太多了）
 *   guest        只读白名单（天气 / 计算 / 读文件 / 搜索 / 知识库）
 *
 * 设计是**白名单 + 黑名单双重过滤**：owner/collaborator 用 `allow: '*'`，
 * 新增工具自动可用；guest 走显式白名单，新增工具必须手动加——默认安全。
 *
 * 关键点：被过滤掉的工具**不会出现在模型的 tools 列表里**——模型根本不知道
 * 有这个工具，自然也不会调用。这比"让它调了再报错"安全得多：模型看到列表里
 * 有 bash，即使你嘱咐"不要用"，它有时还是会试。
 *
 * Channel 那节保留的 senderId 就是为此准备的：未来可按来源分配角色
 * （终端默认 owner，飞书群按 open_id 查角色表）。
 */

export type Role = 'owner' | 'collaborator' | 'guest';

export interface UserIdentity {
  id: string;
  name: string;
  role: Role;
}

const TOOL_ACCESS: Record<Role, { allow: string[] | '*'; deny: string[] }> = {
  owner: { allow: '*', deny: [] },
  collaborator: { allow: '*', deny: ['bash'] },
  guest: {
    allow: ['get_weather', 'calculator', 'read_file', 'list_directory', 'glob', 'grep', 'rag_search'],
    deny: [],
  },
};

export function canUseTool(role: Role, toolName: string): boolean {
  const access = TOOL_ACCESS[role];
  if (!access) return false;
  if (access.deny.includes(toolName)) return false;
  if (access.allow === '*') return true;
  return access.allow.includes(toolName);
}

export function filterToolsForRole(toolNames: string[], role: Role): string[] {
  return toolNames.filter((name) => canUseTool(role, name));
}
