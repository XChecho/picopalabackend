import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';

export interface ResponseFormat<T> {
  data: T;
  statusCode: number;
  timestamp: string;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ResponseFormat<T>> {
  intercept(context: ExecutionContext, next: CallHandler): Promise<ResponseFormat<T>> | ResponseFormat<T> {
    return next.handle().toPromise().then((data: T) => ({
      data,
      statusCode: context.switchToHttp().getResponse().statusCode,
      timestamp: new Date().toISOString(),
    }));
  }
}
