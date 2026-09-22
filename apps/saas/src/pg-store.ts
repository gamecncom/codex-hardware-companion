/** Production persistence adapter boundary. Migrations define the durable schema; service methods remain transaction-owned. */
import pg from 'pg';
const { Pool }=pg;
export class PostgresStore {
  readonly pool:pg.Pool;
  constructor(connectionString=process.env.DATABASE_URL){if(!connectionString)throw new Error('DATABASE_URL is required for PostgresStore');this.pool=new Pool({connectionString,max:5});}
  async health(){const result=await this.pool.query('SELECT 1 AS ok');return result.rows[0]?.ok===1;}
  async close(){await this.pool.end();}
  async transaction<T>(fn:(client:pg.PoolClient)=>Promise<T>):Promise<T>{const client=await this.pool.connect();try{await client.query('BEGIN');const out=await fn(client);await client.query('COMMIT');return out;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
  async saveState(state:unknown){await this.pool.query('INSERT INTO hc_state(id,payload,updated_at) VALUES (1,$1,now()) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()',[JSON.stringify(state)]);}
  async loadState<T=unknown>():Promise<T|null>{const r=await this.pool.query('SELECT payload FROM hc_state WHERE id=1');return r.rows[0]?.payload??null;}
}
