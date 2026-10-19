/**
 * ============================================================================
 * 工具定义与内置工具 (Tools Definition)
 * ============================================================================
 *
 * 工具定义 = AI SDK 格式（description + inputSchema + execute）+ 运行时元数据，
 * 统一收进 ToolDefinition 契约，每个工具额外声明：
 * - isConcurrencySafe：能否和其他工具并行执行（只读工具通常可以）
 * - isReadOnly：是否只读（不修改系统状态）
 * - maxResultChars：结果最大字符数，超出由 ToolRegistry 统一截断
 *
 * 这样工具定义同时服务两个消费者：模型看 description 和 parameters 决定怎么调，
 * Agent Loop 看三个元数据决定怎么管。
 *
 * 【工具清单】
 * 1. get_weather     查询城市天气         只读 · 可并发
 * 2. calculator      计算数学表达式       只读 · 可并发
 * 3. read_file       读取文件内容         只读 · 可并发 · 结果上限 500（演示截断）
 * 4. write_file      写入文件             读写 · 独占
 * 5. list_directory  列出目录内容         只读 · 可并发
 *
 * 【补齐装备】
 * 6. edit_file       精确替换文件内容     读写 · 独占
 * 7. glob            按模式递归找文件     只读 · 可并发 · 上限 100 条
 * 8. grep            正则搜索文件内容     只读 · 可并发 · 上限 50 条
 * 9. bash            执行 shell 命令      读写 · 独占 · 10 秒超时
 *
 * 【小试牛刀】
 * 10. start_preview  启动 app/ 预览服务器 读写 · 独占
 *
 * 注：fetch_url 已由 search-tools.ts 的 web_fetch 取代（Turndown 转 Markdown，
 * 保留标题层级 / 链接 / 代码块，信息密度更高）。
 *
 * 架构一行未动：新增工具只是多注册几个 ToolDefinition，
 * ToolRegistry 的锁、截断与执行管线原样复用，Agent Loop 不感知。
 */

import * as fs from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import * as path from 'node:path';
import type { ToolDefinition } from './registry.js';

/**
 * 1. 天气查询工具 (get_weather)
 *
 * 解决模型无法获取现实世界外部信息的问题。演示用固定数据，
 * 生产环境应替换为真实气象 API 调用。
 */
export const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: '查询指定城市的天气信息，包括温度、天气状况与风向。',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名称，如"北京"、"上海"、"宁波"' },
    },
    required: ['city'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ city }: { city: string }) => {
    const mockWeather: Record<string, string> = {
      '北京': '晴，15-25°C，东南风 2 级',
      '上海': '多云，18-22°C，西南风 3 级',
      '宁波': '舒适，20-24°C，东风 2 级',
      '深圳': '阵雨，22-28°C，南风 2 级',
    };
    return mockWeather[city] || `${city}：暂无实时天气数据，气温约 20°C，多云`;
  },
};

/**
 * 2. 数学计算器工具 (calculator)
 *
 * 解决大语言模型容易在复杂数字运算上产生幻觉的问题。
 * 表达式先做白名单字符过滤再交给 Function 求值，避免执行任意代码。
 */
export const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description: '计算数学表达式的结果。当用户提问涉及数学运算时使用。',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '数学表达式，如 "2 + 3 * 4" 或 "1234 * 5678"' },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ expression }: { expression: string }) => {
    try {
      // 只保留数字与四则运算符号，其余字符一律剔除后再求值
      const sanitized = expression.replace(/[^0-9+\-*/(). %]/g, '');
      const result = new Function(`return (${sanitized})`)();
      return `${expression} = ${result}`;
    } catch {
      return `无法计算该表达式: ${expression}`;
    }
  },
};

/**
 * 3. 本地文件读取工具 (read_file)
 *
 * 赋能智能体读取代码和项目配置的能力。
 * maxResultChars 故意设为 500（生产环境通常 50000+），
 * 目的是让「读取大文件触发 Head/Tail 截断」能被直观演示出来。
 */
export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: '读取本地工作区中的文件内容。传入相对路径（如 "package.json" 或 "sample-data.txt"）。',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: '文件的相对路径，如 package.json' },
    },
    required: ['filePath'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 500,
  execute: async ({ filePath }: { filePath: string }) => {
    try {
      const resolvedPath = path.resolve(process.cwd(), filePath);
      return await fs.readFile(resolvedPath, 'utf-8');
    } catch (err: any) {
      return `读取文件失败: ${err.message || String(err)}`;
    }
  },
};

/**
 * 4. 文件写入工具 (write_file)
 *
 * 第一个有副作用的工具。isConcurrencySafe 必须为 false：
 * 写入过程中不能被其他工具读到半成品文件，因此需要独占锁。
 */
export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: '写入内容到指定文件。传入相对路径与要写入的文本内容。',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: '文件的相对路径' },
      content: { type: 'string', description: '要写入的内容' },
    },
    required: ['filePath', 'content'],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ filePath, content }: { filePath: string; content: string }) => {
    try {
      const resolvedPath = path.resolve(process.cwd(), filePath);
      await fs.writeFile(resolvedPath, content, 'utf-8');
      return `已写入 ${content.length} 字符到 ${filePath}`;
    } catch (err: any) {
      return `写入文件失败: ${err.message || String(err)}`;
    }
  },
};

/**
 * 5. 目录列举工具 (list_directory)
 *
 * 让 Agent 能先看清工作区有哪些文件，再决定读哪个。
 * 让模型不必再靠猜「当前目录通常有 src、package.json」。
 */
export const listDirectoryTool: ToolDefinition = {
  name: 'list_directory',
  description: '列出指定目录下的文件和子目录。目录路径省略时默认当前目录。',
  parameters: {
    type: 'object',
    properties: {
      dirPath: { type: 'string', description: '目录路径，默认为当前目录' },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ dirPath = '.' }: { dirPath?: string }) => {
    try {
      const resolvedPath = path.resolve(process.cwd(), dirPath);
      const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
      return entries
        .map((entry) => `${entry.isDirectory() ? '[DIR]' : '[FILE]'} ${entry.name}`)
        .join('\n');
    } catch (err: any) {
      return `读取目录失败: ${err.message || String(err)}`;
    }
  },
};

// ============================================================================
// 补齐装备 —— edit_file / glob / grep / bash
// ============================================================================

/**
 * 6. 精确编辑工具 (edit_file)
 *
 * write_file 的替代方案：模型改一行，不需要把整个文件重新生成一遍。
 * 用 old_string 定位、new_string 替换，只改指定的部分——Claude Code 的 Edit
 * 工具采用的就是这个思路。
 *
 * 两条错误信息的设计要点：它们不是给人看的，是给模型看的。
 * 模型收到「未找到匹配」会去检查缩进和空格，收到「多处匹配」会扩大上下文
 * 重新定位——好的错误信息让模型自我修正。
 */
export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: '精确替换文件中的指定内容。用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆写——只改你指定的部分',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要被替换的原始文本（必须精确匹配）' },
      new_string: { type: 'string', description: '替换后的新文本' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  // 参数名用 path；局部改名 filePath 是为了不遮蔽上面 import 的 path 模块
  execute: async ({ path: filePath, old_string, new_string }: { path: string; old_string: string; new_string: string }) => {
    const resolved = path.resolve(process.cwd(), filePath);
    if (!existsSync(resolved)) return `文件不存在: ${filePath}`;

    const content = readFileSync(resolved, 'utf-8');
    const count = content.split(old_string).length - 1;

    if (count === 0) {
      return `未找到匹配内容。请检查 old_string 是否与文件中的文本完全一致（包括空格和换行）`;
    }
    if (count > 1) {
      return `找到 ${count} 处匹配，请提供更多上下文让 old_string 唯一`;
    }

    const updated = content.replace(old_string, new_string);
    writeFileSync(resolved, updated, 'utf-8');
    return `已替换 ${filePath} 中的内容（${old_string.length} → ${new_string.length} 字符）`;
  },
};

// ---- glob / grep 共用的遍历基础设施 ----------------------------------------

/** 递归遍历时永远跳过的目录：这两个目录一搜就是几万条结果 */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** glob 结果上限，防止大项目撑爆上下文 */
const GLOB_RESULT_LIMIT = 100;

/** grep 匹配行上限 */
const GREP_MATCH_LIMIT = 50;

// 把 glob 模式翻译成正则：双星号跨目录、单星号匹配单层内任意字符、问号匹配单个字符。
// 注意双星号后跟斜杠时要翻译成「零层或多层目录」，
// 否则它匹配不到根目录下的文件（如 index.ts）。
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * 递归遍历目录下的所有文件
 *
 * visit 返回 false 表示「收集已满」，遍历立即停止。
 * 单个目录读不动（权限/不存在）时跳过，不打断整次搜索。
 */
async function walkFiles(dir: string, visit: (absPath: string) => Promise<boolean> | boolean): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (!(await walkFiles(absPath, visit))) return false;
      } else if (entry.isFile()) {
        if (!(await visit(absPath))) return false;
      }
    }
  } catch {
    // 跳过这个目录，继续别处
  }
  return true;
}

/**
 * 7. 文件搜索工具 (glob)
 *
 * list_directory 只能看一层目录，glob 负责递归找文件。
 * 匹配时用「相对搜索目录」的路径，返回时用「相对工作目录」的路径——
 * 这样模型拿到结果可以直接喂给 read_file / edit_file。
 */
export const globTool: ToolDefinition = {
  name: 'glob',
  description: '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式，如 "**/*.ts"、"src/*.json"' },
      path: { type: 'string', description: '搜索起始目录，默认当前目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ pattern, path: searchPath = '.' }: { pattern: string; path?: string }) => {
    const base = path.resolve(process.cwd(), searchPath);
    const matcher = globToRegExp(pattern);
    const matches: string[] = [];
    let truncated = false;

    await walkFiles(base, (absPath) => {
      const relToBase = path.relative(base, absPath).split(path.sep).join('/');
      if (matcher.test(relToBase)) {
        matches.push(path.relative(process.cwd(), absPath).split(path.sep).join('/'));
        if (matches.length >= GLOB_RESULT_LIMIT) {
          truncated = true;
          return false;
        }
      }
      return true;
    });

    if (matches.length === 0) return `未找到匹配 "${pattern}" 的文件`;
    const list = matches.join('\n');
    return truncated ? `${list}\n... [结果达到 ${GLOB_RESULT_LIMIT} 条上限，已截断]` : list;
  },
};

/**
 * 8. 内容搜索工具 (grep)
 *
 * 模型要改一个函数，第一步不是读整个文件，而是搜到它在哪、被谁调用。
 * 返回格式是「文件名:行号: 内容」，跟终端 grep -rn 一致——
 * 模型对这个格式非常熟悉，能直接提取路径和行号去调 read_file / edit_file。
 */
export const grepTool: ToolDefinition = {
  name: 'grep',
  description: '在文件中搜索匹配指定模式的内容。返回匹配的行号和内容',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则表达式）' },
      path: { type: 'string', description: '搜索路径（文件或目录），默认当前目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ pattern, path: searchPath = '.' }: { pattern: string; path?: string }) => {
    let matcher: RegExp;
    try {
      matcher = new RegExp(pattern);
    } catch {
      return `正则表达式无效: ${pattern}`;
    }

    const base = path.resolve(process.cwd(), searchPath);
    const results: string[] = [];
    let truncated = false;

    const searchFile = async (absPath: string): Promise<boolean> => {
      let content: string;
      try {
        content = await fs.readFile(absPath, 'utf-8');
      } catch {
        return true; // 读不了的文件直接跳过
      }
      if (content.includes('\u0000')) return true; // 二进制文件跳过

      const relPath = path.relative(process.cwd(), absPath).split(path.sep).join('/');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (matcher.test(lines[i])) {
          results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
          if (results.length >= GREP_MATCH_LIMIT) {
            truncated = true;
            return false;
          }
        }
      }
      return true;
    };

    const stat = await fs.stat(base).catch(() => null);
    if (!stat) return `路径不存在: ${searchPath}`;

    if (stat.isFile()) {
      await searchFile(base);
    } else {
      await walkFiles(base, searchFile);
    }

    if (results.length === 0) return `未找到匹配 "${pattern}" 的内容`;
    const list = results.join('\n');
    return truncated ? `${list}\n... [匹配达到 ${GREP_MATCH_LIMIT} 条上限，已截断]` : list;
  },
};

/**
 * 9. 命令执行工具 (bash)
 *
 * 最强也最危险：能跑测试、装依赖、查环境，也能一个 rm -rf 搞挂系统。
 * 三个设计决策：
 * - 超时 10 秒：防止模型跑一个死循环卡死整个进程；
 * - 环境检测：不支持 shell 的环境（如 WebContainer）直接返回提示，不 crash；
 * - 默认串行：命令可能有副作用，拿独占锁。
 *
 * 更精细的做法是「分析命令内容判断是否只读」（ls 可并发、rm 必须串行），
 * 那是后面权限系统那一节的事。
 */
export const bashTool: ToolDefinition = {
  name: 'bash',
  description: '执行 shell 命令并返回输出。适合运行脚本、检查环境、执行构建等操作',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  maxResultChars: 3000,
  execute: async ({ command }: { command: string }) => {
    // 先检测环境是否支持 child_process
    try {
      execSync('echo test', { stdio: 'ignore' });
    } catch {
      return `[bash 不可用] 当前环境不支持 shell 命令。本地终端运行可使用。`;
    }

    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        timeout: 10000, // 10 秒超时
        maxBuffer: 1024 * 1024,
      });
      return output || '(命令执行成功，无输出)';
    } catch (err: any) {
      return `命令执行失败 (exit ${err.status || 1}):\n${err.stderr || err.message}`;
    }
  },
};

// ============================================================================
// 小试牛刀 —— 把工具组装成应用（start_preview）
// ============================================================================

// ---- 预览服务器（Vibe Coding demo 用）--------------------------------------

/** 进程内单例：重复调用只返回已有地址，不会重复占端口 */
let previewServer: Server | null = null;

/** 常见静态资源的 Content-Type */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.tsx': 'application/javascript; charset=utf-8', // 让浏览器把 .tsx 当 JS 加载
  '.ts': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/**
 * 11. 预览服务器工具 (start_preview)
 *
 * 把 app/ 目录用一个 Node 内置 http server 暴露到 8080 端口，
 * 让 Vibe Coding 的产物「写完就能看」。
 *
 * isConcurrencySafe: false —— 它是有副作用的写操作，拿独占锁；
 * 在 Agent Loop 里它自然排到所有 write_file 之后，保证文件全部就位再起服务。
 */
export const startPreviewTool: ToolDefinition = {
  name: 'start_preview',
  description: '启动 app/ 目录的预览服务器。生成应用文件后必须立即调用此工具',
  parameters: {
    type: 'object',
    properties: { port: { type: 'number', description: '端口号，默认 8080' } },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ port = 8080 }: { port?: number } = {}) => {
    if (previewServer) return `预览服务器已在运行 → http://localhost:${port}`;
    const root = path.resolve(process.cwd(), 'app');
    if (!existsSync(root)) return '错误：app/ 目录不存在';

    previewServer = createServer((req, res) => {
      const urlPath = (req.url?.split('?')[0] || '/').replace(/\/$/, '/index.html');
      const filePath = path.join(root, urlPath === '/' ? '/index.html' : urlPath);
      try {
        // 防目录穿越：解析后的路径必须仍在 app/ 内
        if (!filePath.startsWith(root)) {
          res.writeHead(403);
          res.end();
          return;
        }
        // 刻意先读文件、再写响应头——顺序反了会在文件缺失时崩：
        // 浏览器会顺手请求 favicon.ico 这类不存在的文件，若先 writeHead(200)
        // 再读文件失败，404 分支会抛 ERR_HTTP_HEADERS_SENT，把整个进程带崩。
        const body = readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    return new Promise<string>((resolvePromise) => {
      previewServer!.listen(port, () => {
        resolvePromise(`✓ 预览服务器已启动 → http://localhost:${port}`);
      });
    });
  },
};

/**
 * 汇总导出全部可用工具
 *
 * 注意这里是数组而非对象：ToolRegistry.register(...allTools) 需要展开传入。
 */
export const allTools: ToolDefinition[] = [
  weatherTool,
  calculatorTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  startPreviewTool,
];
