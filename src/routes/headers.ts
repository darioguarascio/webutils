import { Request, Response } from 'express';

const handler = async function(req: Request, res: Response) {
  res.json( req.headers ).end()
};


export default handler;