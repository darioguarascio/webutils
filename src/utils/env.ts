import dotenv from 'dotenv';
dotenv.config();

interface Env {
  [key: string]: any;
  APP_ENV: string;
  APP_NAME: string;
  CORS_METHODS: string;
  CORS_ORIGIN: string;
  LISTENING_PORT: number;
  VERSION: string;
}

/**
 * Helper class to retrive config from env var (when running with docker) or local file (when running in dev)
 */
let getv = function (name: string, def: any) : any {
  return process.env[name] || def;
};

const envs : Env = {
  APP_ENV: getv('APP_ENV','dev'),
  APP_NAME: getv('APP_NAME', 'virail-chatbot'),
  CORS_METHODS: getv('CORS_METHODS', 'GET,POST'),
  CORS_ORIGIN: getv('CORS_ORIGIN','*').split(','),
  LISTENING_PORT: parseInt(getv('LISTENING_PORT', 3000)),
  VERSION: getv('VERSION', '0.0.0'),
}

export default envs;