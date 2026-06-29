import {
  Controller,
  Get,
  Query,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';

import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import {
  GlobalSearchDto,
  GlobalSearchResponseDto,
  SuggestionsResponseDto,
} from './dto/global-search.dto';
import { SearchService } from './search.service';

@ApiTags('Search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Public()
  @Get('suggestions')
  @ApiOperation({
    summary: 'Autocomplete suggestions for markets and users (public)',
    description:
      'Returns up to 5 market titles and 5 usernames that start with the given term.',
  })
  @ApiResponse({ status: 200, type: SuggestionsResponseDto })
  async getSuggestions(@Query('q') q: string): Promise<SuggestionsResponseDto> {
    return this.searchService.getSuggestions(q);
  }

  @Public()
  @Get()
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  )
  @ApiOperation({
    summary: 'Global search across markets, users, and competitions (public)',
    description:
      'Searches across multiple entity types using a single query string. ' +
      'Results can be filtered by type and are paginated. ' +
      'Only public markets, non-banned users, and public competitions are returned.',
  })
  @ApiResponse({ status: 200, type: GlobalSearchResponseDto })
  async search(
    @Query() query: GlobalSearchDto,
  ): Promise<GlobalSearchResponseDto> {
    return this.searchService.search(query);
  }
}
