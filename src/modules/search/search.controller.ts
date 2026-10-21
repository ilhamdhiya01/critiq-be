import { Controller, Get, Param, Query } from '@nestjs/common';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { SearchQueryDto } from './dto/search.dto';
import { SearchService } from './search.service';

// The ⌘K palette — read-only, every role.
@Controller('orgs/:orgId/search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @OrgAuth([])
  @ResponseMessage('Search results retrieved successfully')
  search(@Param('orgId') orgId: string, @Query() query: SearchQueryDto) {
    return this.searchService.search(orgId, query.q, query.limit);
  }
}
