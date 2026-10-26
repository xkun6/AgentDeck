// which@5 是 CommonJS（module.exports = which），没有自带类型；这里只声明 sidecar 用到的部分。
declare module "which" {
  interface WhichOptions {
    path?: string;
    pathExt?: string;
    nothrow?: boolean;
  }

  function which(cmd: string, options: WhichOptions & { all: true }): Promise<string[]>;
  function which(cmd: string, options?: WhichOptions & { all?: false }): Promise<string>;
  namespace which {
    function sync(cmd: string, options: WhichOptions & { nothrow: true; all?: false }): string | null;
  }

  export default which;
}
