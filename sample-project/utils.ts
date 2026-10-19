// 模拟一个有技术债的工具层——故意留了未完成标记
export function formatDate(date: Date): string {
  // TODO: 支持多时区，目前只输出本地时间
  return date.toLocaleString('zh-CN');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
