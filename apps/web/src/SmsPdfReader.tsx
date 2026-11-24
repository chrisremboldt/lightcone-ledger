import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AnnotationMode, type PDFDocumentProxy } from 'pdfjs-dist';
import { EventBus, FindState, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { Button, Notice, Spinner } from '@ledger/ui';
import { loadPdf, pdfAssetsUrl } from './sms-pdf.js';
import 'pdfjs-dist/web/pdf_viewer.css';
import './styles/sms-pdf-reader.css';

type Destination = Parameters<PDFLinkService['goToDestination']>[0];
interface OutlineNode {
  title: string;
  dest: Destination | null;
  items: OutlineNode[];
}
interface OutlineDestination {
  title: string;
  destination: Destination;
}
interface PdfSession {
  viewer: PDFViewer;
  events: EventBus;
  links: PDFLinkService;
}
interface MatchEvent {
  matchesCount: { current: number; total: number };
  state?: number;
}

function outlineDestinations(nodes: OutlineNode[], depth = 0): OutlineDestination[] {
  return nodes.flatMap((node) => [
    ...(node.dest ? [{ title: `${'— '.repeat(Math.min(depth, 4))}${node.title}`, destination: node.dest }] : []),
    ...outlineDestinations(node.items ?? [], depth + 1),
  ]);
}

async function hasSearchableText(document: PDFDocumentProxy, stopped: () => boolean): Promise<boolean | null> {
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    if (stopped()) return null;
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    if (content.items.some((item) => 'str' in item && item.str.trim())) return true;
  }
  return false;
}

export default function SmsPdfReader({ bytes, label }: { bytes: Uint8Array; label: string }) {
  const container = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const pageInput = useRef<HTMLInputElement>(null);
  const session = useRef<PdfSession | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [renderFailure, setRenderFailure] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageDraft, setPageDraft] = useState('1');
  const [query, setQuery] = useState('');
  const [findStatus, setFindStatus] = useState('');
  const [textStatus, setTextStatus] = useState<'checking' | 'available' | 'none' | 'unavailable'>('checking');
  const [zoom, setZoom] = useState('page-width');
  const [outline, setOutline] = useState<OutlineDestination[]>([]);
  const [outlineSelection, setOutlineSelection] = useState('');

  useEffect(() => {
    const scrollContainer = container.current;
    const pageContainer = pages.current;
    if (!scrollContainer || !pageContainer) return;
    let stopped = false;
    let encrypted = false;
    setReady(false);
    setFailure(null);
    setRenderFailure(false);
    setPageCount(0);
    setPageNumber(1);
    setPageDraft('1');
    setQuery('');
    setFindStatus('');
    setTextStatus('checking');
    setOutline([]);
    setOutlineSelection('');
    setZoom('page-width');

    const events = new EventBus();
    const links = new PDFLinkService({ eventBus: events, ignoreDestinationZoom: true });
    links.externalLinkEnabled = false;
    const find = new PDFFindController({ eventBus: events, linkService: links, delay: 150 });
    const viewer = new PDFViewer({
      container: scrollContainer,
      viewer: pageContainer,
      eventBus: events,
      linkService: links,
      findController: find,
      annotationMode: AnnotationMode.ENABLE,
      enableAutoLinking: false,
      imageResourcesPath: `${pdfAssetsUrl}web/images/`,
      maxCanvasPixels: 16 * 1024 * 1024,
      maxCanvasDim: 8192,
    });
    links.setViewer(viewer);
    session.current = { viewer, events, links };
    const initialized = () => {
      if (stopped) return;
      viewer.currentScaleValue = 'page-width';
      setReady(true);
    };
    const pageChanged = ({ pageNumber: next }: { pageNumber: number }) => {
      if (stopped) return;
      setPageNumber(next);
      if (document.activeElement !== pageInput.current) setPageDraft(String(next));
    };
    const matchesChanged = ({ matchesCount, state }: MatchEvent) => {
      if (stopped) return;
      setFindStatus(
        state === FindState.PENDING
          ? 'Searching all pages…'
          : state === FindState.NOT_FOUND
            ? 'No matches in this document.'
            : matchesCount.total
              ? `${matchesCount.current} of ${matchesCount.total} matches`
              : '',
      );
    };
    const pageRendered = ({ error }: { error?: unknown }) => {
      if (!stopped && error) setRenderFailure(true);
    };
    let resizeFrame = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (stopped || !viewer.pdfDocument) return;
        const scale = viewer.currentScaleValue;
        if (scale === 'page-width' || scale === 'page-fit') viewer.currentScaleValue = scale;
        viewer.update();
      });
    });
    resize.observe(scrollContainer);
    events.on('pagesinit', initialized);
    events.on('pagechanging', pageChanged);
    events.on('updatefindmatchescount', matchesChanged);
    events.on('updatefindcontrolstate', matchesChanged);
    events.on('pagerendered', pageRendered);
    const loading = loadPdf(bytes);
    loading.onPassword = () => {
      encrypted = true;
      if (!stopped)
        setFailure('This PDF is encrypted. Download the original and open it with an authorized PDF application.');
      void loading.destroy().catch(() => {});
    };
    void loading.promise
      .then(async (pdf) => {
        if (stopped) return;
        setPageCount(pdf.numPages);
        links.setDocument(pdf);
        viewer.setDocument(pdf);
        void pdf
          .getOutline()
          .then((nodes) => {
            if (!stopped) setOutline(outlineDestinations(nodes ?? []));
          })
          .catch(() => {});
        void hasSearchableText(pdf, () => stopped)
          .then((searchable) => {
            if (!stopped && searchable !== null) setTextStatus(searchable ? 'available' : 'none');
          })
          .catch(() => {
            if (!stopped) setTextStatus('unavailable');
          });
      })
      .catch(() => {
        if (!stopped && !encrypted)
          setFailure(
            'This PDF could not be opened. It may be damaged or use an unsupported format. Download the original to inspect it.',
          );
      });
    return () => {
      stopped = true;
      resize.disconnect();
      cancelAnimationFrame(resizeFrame);
      session.current = null;
      events.off('pagesinit', initialized);
      events.off('pagechanging', pageChanged);
      events.off('updatefindmatchescount', matchesChanged);
      events.off('updatefindcontrolstate', matchesChanged);
      events.off('pagerendered', pageRendered);
      viewer.setDocument(null);
      links.setDocument(null);
      void loading.destroy().catch(() => {});
    };
  }, [bytes]);

  useEffect(() => {
    if (!ready) return;
    session.current?.events.dispatch('find', {
      source: findInput.current,
      type: '',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: false,
      matchDiacritics: false,
    });
    if (!query) setFindStatus('');
  }, [query, ready]);

  function findAgain(previous: boolean) {
    session.current?.events.dispatch('find', {
      source: findInput.current,
      type: 'again',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  }
  function goToPage(next: number) {
    const current = session.current;
    if (!current || !Number.isInteger(next) || next < 1 || next > pageCount) {
      setPageDraft(String(pageNumber));
      return;
    }
    current.links.goToPage(next);
    setPageDraft(String(next));
  }
  function submitPage(event: FormEvent) {
    event.preventDefault();
    goToPage(Number(pageDraft));
  }
  function changeZoom(value: string) {
    setZoom(value);
    if (session.current) session.current.viewer.currentScaleValue = value;
  }
  function keyDown(event: KeyboardEvent<HTMLElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      findInput.current?.focus();
      findInput.current?.select();
    }
  }

  return (
    <section className="sms-pdf-reader" aria-label={`${label} PDF reader`} onKeyDown={keyDown}>
      <div className="sms-pdf-toolbar" aria-label="PDF controls">
        <form className="sms-pdf-page-controls" aria-label="PDF page navigation" onSubmit={submitPage}>
          <Button
            kind="quiet"
            type="button"
            disabled={!ready || pageNumber <= 1}
            onClick={() => goToPage(pageNumber - 1)}
            aria-label="Previous page"
          >
            ←
          </Button>
          <label>
            Page{' '}
            <input
              ref={pageInput}
              aria-label="Page number"
              type="number"
              inputMode="numeric"
              min={1}
              max={pageCount || 1}
              value={pageDraft}
              onChange={(event) => setPageDraft(event.target.value)}
              onBlur={() => goToPage(Number(pageDraft))}
              disabled={!ready}
            />
          </label>
          <span>of {pageCount || '—'}</span>
          <Button
            kind="quiet"
            type="button"
            disabled={!ready || pageNumber >= pageCount}
            onClick={() => goToPage(pageNumber + 1)}
            aria-label="Next page"
          >
            →
          </Button>
        </form>
        <label className="sms-pdf-zoom">
          <span className="sr-only">PDF zoom</span>
          <select
            aria-label="PDF zoom"
            value={zoom}
            onChange={(event) => changeZoom(event.target.value)}
            disabled={!ready}
          >
            <option value="page-width">Fit width</option>
            <option value="page-fit">Fit page</option>
            <option value="0.75">75%</option>
            <option value="1">100%</option>
            <option value="1.25">125%</option>
            <option value="1.5">150%</option>
            <option value="2">200%</option>
          </select>
        </label>
        <label className="sms-pdf-outline">
          <span className="sr-only">Document outline</span>
          <select
            aria-label="Document outline"
            value={outlineSelection}
            disabled={!ready || outline.length === 0}
            onChange={(event) => {
              setOutlineSelection(event.target.value);
              const selected = outline[Number(event.target.value)];
              if (selected)
                void session.current?.links.goToDestination(selected.destination).catch(() => setRenderFailure(true));
            }}
          >
            <option value="">{outline.length ? 'Document outline' : 'No document outline'}</option>
            {outline.map((entry, index) => (
              <option key={index} value={index}>
                {entry.title}
              </option>
            ))}
          </select>
        </label>
        <div className="sms-pdf-find">
          <input
            ref={findInput}
            type="search"
            aria-label="Find in document"
            placeholder="Find in document"
            value={query}
            disabled={!ready || textStatus === 'none'}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                findAgain(event.shiftKey);
              }
            }}
          />
          <Button
            kind="quiet"
            type="button"
            disabled={!ready || !query}
            aria-label="Previous match"
            onClick={() => findAgain(true)}
          >
            ↑
          </Button>
          <Button
            kind="quiet"
            type="button"
            disabled={!ready || !query}
            aria-label="Next match"
            onClick={() => findAgain(false)}
          >
            ↓
          </Button>
        </div>
        <span className="sms-pdf-find-status" role="status" aria-live="polite">
          {findStatus}
        </span>
      </div>
      {failure ? (
        <Notice tone="alert" title="PDF unavailable">
          {failure}
        </Notice>
      ) : (
        <>
          {!ready && (
            <div className="sms-pdf-message">
              <Spinner label="Opening the retained PDF" />
            </div>
          )}
          {renderFailure && (
            <Notice title="A PDF page could not be displayed">
              Download the original to inspect its complete content.
            </Notice>
          )}
          {textStatus === 'none' && (
            <p className="sms-pdf-message" role="status">
              This PDF has no searchable text. It may be a scan. You can read its pages or download the original.
            </p>
          )}
          {textStatus === 'unavailable' && (
            <p className="sms-pdf-message" role="status">
              Searchable text could not be read. Download the original if a page is incomplete.
            </p>
          )}
        </>
      )}
      <div className="sms-pdf-stage" hidden={Boolean(failure)}>
        <div className="sms-pdf-scroll" ref={container} tabIndex={0} aria-label="PDF pages">
          <div ref={pages} className="pdfViewer" />
        </div>
      </div>
    </section>
  );
}
