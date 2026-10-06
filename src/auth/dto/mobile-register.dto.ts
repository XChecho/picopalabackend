import { IsIn } from 'class-validator';
import { MOBILE_PLATFORMS, MobilePlatform } from './mobile-platform';
import { RegisterBaseDto } from './register-base.dto';

export class MobileRegisterDto extends RegisterBaseDto {
  @IsIn(MOBILE_PLATFORMS)
  platform!: MobilePlatform;
}
