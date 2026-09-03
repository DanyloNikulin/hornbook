import { Pipe, PipeTransform, inject } from '@angular/core';
import type { Vars } from '../lib/i18n';
import { I18nService } from './i18n.service';

/** Impure so a later locale change repaints without threading the locale through every call. */
@Pipe({ name: 't', pure: false })
export class TPipe implements PipeTransform {
  private readonly i18n = inject(I18nService);

  transform(key: string, vars?: Vars): string {
    return this.i18n.t(key, vars);
  }
}
