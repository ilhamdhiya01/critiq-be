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
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';

interface RequestWithSession extends Request {
  user: JwtPayload;
}

// PR comments (v1.5.2), nested under the PR like the pulls routes.
@Controller('orgs/:orgId/repos/:repoId/pulls/:id/comments')
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Get()
  @OrgAuth([])
  @ResponseMessage('Comments retrieved successfully')
  list(
    @Param('orgId') orgId: string,
    @Param('repoId') repoId: string,
    @Param('id') id: string,
  ) {
    return this.commentsService.list(orgId, repoId, id);
  }

  // A Viewer reads only (PRD §7).
  @Post()
  @OrgAuth([Role.ADMIN, Role.REVIEWER])
  @ResponseMessage('Comment created')
  create(
    @Req() req: RequestWithSession,
    @Param('orgId') orgId: string,
    @Param('repoId') repoId: string,
    @Param('id') id: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.commentsService.create(orgId, repoId, id, req.user.sub, dto);
  }

  // 202: queued again — poll GET …/comments for the result.
  @Post(':commentId/sync')
  @OrgAuth([Role.ADMIN, Role.REVIEWER])
  @HttpCode(HttpStatus.ACCEPTED)
  @ResponseMessage('Comment sync requested')
  retrySync(
    @Param('orgId') orgId: string,
    @Param('repoId') repoId: string,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
  ) {
    return this.commentsService.retrySync(orgId, repoId, id, commentId);
  }
}
