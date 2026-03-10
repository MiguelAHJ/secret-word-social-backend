import {
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Global HTTP exception filter.
 *
 * Catches every HttpException (and every unhandled error) and returns a
 * consistent JSON envelope so consumers always get the same error shape:
 *
 * {
 *   statusCode: 404,
 *   message:    "No words found for category \"XYZ\"",
 *   error:      "Not Found",
 *   path:       "/words/random",
 *   timestamp:  "2026-03-09T12:00:00.000Z"
 * }
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(GlobalExceptionFilter.name);

    catch(exception: unknown, host: ArgumentsHost): void {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        const isHttpException = exception instanceof HttpException;
        const status = isHttpException
            ? exception.getStatus()
            : HttpStatus.INTERNAL_SERVER_ERROR;

        const exceptionResponse = isHttpException
            ? exception.getResponse()
            : { message: 'Internal server error' };

        const message =
            typeof exceptionResponse === 'string'
                ? exceptionResponse
                : (exceptionResponse as Record<string, unknown>).message ?? 'Error';

        const error =
            typeof exceptionResponse === 'object'
                ? ((exceptionResponse as Record<string, unknown>).error ??
                    HttpStatus[status])
                : HttpStatus[status];

        if (!isHttpException) {
            this.logger.error(exception);
        }

        response.status(status).json({
            statusCode: status,
            message,
            error,
            path: request.url,
            timestamp: new Date().toISOString(),
        });
    }
}
