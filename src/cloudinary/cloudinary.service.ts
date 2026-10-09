import { Injectable, BadRequestException } from "@nestjs/common";
import { v2 as cloudinary } from "cloudinary";
import { ConfigService } from "@nestjs/config";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

@Injectable()
export class CloudinaryService {
  constructor(private configService: ConfigService) {
    cloudinary.config({
      cloud_name: this.configService.get<string>("CLOUDINARY_CLOUD_NAME"),
      api_key: this.configService.get<string>("CLOUDINARY_API_KEY"),
      api_secret: this.configService.get<string>("CLOUDINARY_API_SECRET"),
    });
  }

  validateFile(file: Express.Multer.File): void {
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException("File size exceeds 5MB limit");
    }

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        "Invalid file type. Allowed types: jpeg, png, webp, gif",
      );
    }
  }

  async uploadImage(file: Express.Multer.File): Promise<string> {
    this.validateFile(file);

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: "picopala/avatars" },
        (error, result) => {
          if (error) reject(error);
          else resolve(result!.secure_url);
        },
      );
      uploadStream.end(file.buffer);
    });
  }

  async deleteImage(url: string): Promise<void> {
    const publicId = url.split("/").pop()!.split(".")[0];
    await cloudinary.uploader.destroy(`picopala/avatars/${publicId}`);
  }
}
