declare module 'pg' {
  export interface PoolConfig {
    connectionString?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    end(): Promise<void>;
  }

  const pg: {
    Pool: typeof Pool;
  };

  export default pg;
}
