declare module "proper-lockfile" {
  const lockfile: {
    lock(
      file: string,
      options?: { stale?: number; retries?: { retries: number; minTimeout?: number; maxTimeout?: number } },
    ): Promise<() => Promise<void>>;
  };
  export default lockfile;
}
