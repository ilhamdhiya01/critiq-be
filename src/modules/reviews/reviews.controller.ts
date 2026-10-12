import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { Role } from '../../generated/prisma/enums';
import type { JwtPayload } from '../auth/auth.service';
import { SubmitReviewDto } from './dto/submit-review.dto';
import { ReviewsService } from './reviews.service';

interface RequestWithSession extends Request {
  user: JwtPayload;
}

// v1.5.2 review decisions, nested under the PR like the pulls routes.
@Controller('orgs/:orgId/repos/:repoId/pulls/:id')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  // Admin and Reviewer decide; a Viewer gets 403 from the guard.
  @Post('review')
  @OrgAuth([Role.ADMIN, Role.REVIEWER])
  @ResponseMessage('Review submitted')
  submit(
    @Req() req: RequestWithSession,
    @Param('orgId') orgId: string,
    @Param('repoId') repoId: string,
    @Param('id') id: string,
    @Body() dto: SubmitReviewDto,
  ) {
    return this.reviewsService.submit(orgId, repoId, id, req.user.sub, dto);
  }

  @Get('reviews')
  @OrgAuth([])
  @ResponseMessage('Reviews retrieved successfully')
  list(
    @Param('orgId') orgId: string,
    @Param('repoId') repoId: string,
    @Param('id') id: string,
  ) {
    return this.reviewsService.list(orgId, repoId, id);
  }

  // 202: queued again — poll the PR or GET …/reviews for the result.
  @Post('reviews/:reviewId/sync')
  @OrgAuth([Role.ADMIN, Role.REVIEWER])
  @HttpCode(HttpStatus.ACCEPTED)
  @ResponseMessage('Review sync requested')
  retrySync(
    @Param('orgId') orgId: string,
    @Param('repoId') repoId: string,
    @Param('id') id: string,
    @Param('reviewId') reviewId: string,
  ) {
    return this.reviewsService.retrySync(orgId, repoId, id, reviewId);
  }
}
