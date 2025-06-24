import cors from 'cors'
import env from '@utils/env.ts'

const corsOptions = {
  origin: '*', // or 'https://your-frontend.com'
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']

  // "origin": env.CORS_ORIGIN,
  // "methods": env.CORS_METHODS,
  // "preflightContinue": false,
  // "optionsSuccessStatus": 204
}

export default cors(corsOptions)