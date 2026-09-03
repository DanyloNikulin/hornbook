import { BaseRouteReuseStrategy, type ActivatedRouteSnapshot } from '@angular/router';

/**
 * Default Angular behaviour reuses a component when only route params change.
 * Under `/:section/...` that would keep a Spanish vocabulary page alive while
 * the URL says Italian. Treat a change of `:section` as a different route so
 * the whole subtree is recreated with fresh section-scoped state.
 */
export class SectionRouteReuse extends BaseRouteReuseStrategy {
  override shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    return future.routeConfig === curr.routeConfig && future.params['section'] === curr.params['section'];
  }
}
