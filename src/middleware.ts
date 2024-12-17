import { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { logger } from './helpers/logger.js';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const statusCode = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(statusCode);
  const responseBody = {
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? '🥞' : err.stack,
  };

  logger.error(
    `error: ${responseBody.message} and stack: ${responseBody.stack}`,
  );
  res.json(responseBody);
}

export interface RequestWithValidation extends Request {
  validatedBody?: any;
}
export const logRequest = (req: Request, res: Response, next: NextFunction) => {
  logger.info(
    `Received ${req.method} request on ${req.path} - Body: ${JSON.stringify(req.body)}`,
  );
  next();
};
export const validateSchema = (schema: ZodSchema) => {
  return (req: RequestWithValidation, res: Response, next: NextFunction) => {
    logger.info(`Validating request - Body: ${JSON.stringify(req.body)}`);

    const result = schema.safeParse(req.body);
    if (!result.success) {
      logger.error(`Validation error: ${result.error.flatten()}`);
      return res
        .status(400)
        .json({ status: 'error', message: result.error.flatten() });
    }
    req.validatedBody = result.data;
    next();
  };
};
