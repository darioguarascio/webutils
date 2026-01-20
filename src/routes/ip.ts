import { Request, Response } from 'express';

const validators = [
];

const handler = async function(req: Request, res: Response) {
  res.set('Content-Type', 'text/plain');
  res.send(
    (req.headers['cf-connecting-ip'] ??
    req.headers['x-forwarded-for'] ??
    req.ip)
    + "\n"
  );
};

export const get = [
  ...validators,
  handler
];