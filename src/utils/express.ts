import express from 'express';
import morgan from '@utils/morgan.ts';
import cors from '@utils/cors.ts'
import router from '@utils/router.ts'

const app = express()

app.set('json spaces', 2)
app.set('trust proxy', false);

app.use(cors);
app.use(morgan)
app.use("/", router)

export default app;

