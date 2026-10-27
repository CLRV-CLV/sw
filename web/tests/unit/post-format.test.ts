import { expect, it } from 'vitest';
import {formatBodyText,sanitizeBodyHtml} from '../../app/utils/format-body';
import {toMediaUrl} from '../../app/utils/image';
import {postExcerpt} from '../../app/utils/post-excerpt';
it('keeps Markdown extensions while restyling the app',()=>{const h=formatBodyText('# Head\n\n- [x] done\n\n==highlight== H~2~O x^2^\n\n$y^2$\n\n|A|B|\n|-|-|\n|1|2|');for(const part of ['<h1>','checkbox','disabled','<mark>','<sub>','<sup>','<math','<table>'])expect(h).toContain(part);});
it('filters unsafe rich HTML and layout injection',()=>{const h=sanitizeBodyHtml('<script>bad()</script><div class="ik-overlay" style="position:fixed">x</div><img src="x" onerror="bad()">');for(const part of ['<script','ik-overlay','position:fixed','onerror'])expect(h).not.toContain(part);});
it('preserves same-origin images',()=>expect(toMediaUrl('/images/zzz.webp')).toBe('/images/zzz.webp'));
it('keeps summaries plain and readable',()=>expect(postExcerpt('<p>Hello <b>world</b></p>')).toBe('Hello world'));
