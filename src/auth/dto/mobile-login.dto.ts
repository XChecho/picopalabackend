import { IsIn } from 'class-validator';
import { LoginBaseDto } from './login-base.dto';
import { MOBILE_PLATFORMS, MobilePlatform } from './mobile-platform';

export class MobileLoginDto extends LoginBaseDto {
  @IsIn(MOBILE_PLATFORMS)
  platform!: MobilePlatform;
}
