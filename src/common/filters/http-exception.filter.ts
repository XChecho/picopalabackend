import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') {
      if (exception instanceof Error) {
        this.logger.error(exception.message, exception.stack);
      }
      throw exception;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: Record<string, string[]> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const res = exceptionResponse as Record<string, unknown>;
        message = (res.message as string) || message;
        errors = res.errors as Record<string, string[]> | undefined;
      }
    } else if (this.isClientHttpError(exception)) {
      // body-parser errors (413 too large, 400 malformed JSON) are http-errors, not HttpException.
      status = exception.status;
      message = status === HttpStatus.PAYLOAD_TOO_LARGE ? 'Payload too large' : 'Bad request';
    } else if (exception instanceof Error) {
      // Never echo internal messages (Prisma errors include table/column names).
      this.logger.error(exception.message, exception.stack);
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...(errors && { errors }),
      timestamp: new Date().toISOString(),
    });
  }

  private isClientHttpError(exception: unknown): exception is Error & { status: number } {
    if (!(exception instanceof Error)) return false;
    const { status, expose } = exception as Error & { status?: unknown; expose?: unknown };
    return expose === true && typeof status === 'number' && status >= 400 && status < 500;
  }
}
