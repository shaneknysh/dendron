import {
  assertUnreachable,
  ConfigUtils,
  DendronError,
  DEngineClient,
  DVault,
  ERROR_STATUS,
  IntermediateDendronConfig,
  NoteProps,
  NotePropsByIdDict,
  NoteUtils,
  ProcFlavor,
} from "@dendronhq/common-all";
// @ts-ignore
import rehypePrism from "@mapbox/rehype-prism";
// @ts-ignore
import mermaid from "@dendronhq/remark-mermaid";
import _ from "lodash";
import link from "rehype-autolink-headings";
import math from "remark-math";
// @ts-ignore
import variables from "remark-variables";
// @ts-ignore
import katex from "rehype-katex";
import raw from "rehype-raw";
import slug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remark from "remark";
import abbrPlugin from "remark-abbr";
import footnotes from "remark-footnotes";
import frontmatterPlugin from "remark-frontmatter";
import remarkParse from "remark-parse";
import remark2rehype from "remark-rehype";
import { Processor } from "unified";
import u from "unist-builder";
import { hierarchies } from "./remark";
import { backlinks } from "./remark/backlinks";
import { BacklinkOpts, backlinksHover } from "./remark/backlinksHover";
import { blockAnchors } from "./remark/blockAnchors";
import { dendronHoverPreview } from "./remark/dendronPreview";
import { dendronPub, DendronPubOpts } from "./remark/dendronPub";
import { extendedImage } from "./remark/extendedImage";
import { hashtags } from "./remark/hashtag";
import { noteRefsV2 } from "./remark/noteRefsV2";
import { userTags } from "./remark/userTags";
import { wikiLinks, WikiLinksOpts } from "./remark/wikiLinks";
import { DendronASTDest } from "./types";
// @ts-ignore
import position from "unist-util-position";

export { ProcFlavor };

/**
 * What mode a processor should run in
 */
export enum ProcMode {
  /**
   * Expect no properties from {@link ProcDataFullV5} when running the processor
   */
  NO_DATA = "NO_DATA",
  /**
   * Expect all properties from {@link ProcDataFullV5} when running the processor
   */
  FULL = "all data",
  /**
   * Running processor in import mode. Notes don't exist. Used for import pods like {@link MarkdownPod}
   * where notes don't exist in the engine prior to import.
   */
  IMPORT = "IMPORT",
}

/**
 * Options for how processor should function
 */
export type ProcOptsV5 = {
  /**
   * Determines what information is passed in to `Proc`
   */
  mode: ProcMode;
  /**
   * Don't attach compiler if `parseOnly`
   */
  parseOnly?: boolean;
  /**
   * Are we using specific variant of processor
   */
  flavor?: ProcFlavor;
};

/**
 * Data to initialize the processor
 *
 * @remark You might have picked up that there is a large overlap between optional properties in `ProcData` and what is available with a `Engine`.
 * This is because depending on what `ProcMode` the processor is operating on, we might not have (or need) access to an `engine`
 * instance (eg. when running a doctor command to check for valid markdown syntax )
 * The additional options are also there as an override - letting us override specific engine props without mutating the engine.
 */
export type ProcDataFullOptsV5 = {
  engine: DEngineClient;
  vault: DVault;
  fname: string;
  dest: DendronASTDest;
  /**
   * Supply alternative dictionary of notes to use when resolving note ids
   */
  notes?: NotePropsByIdDict;
  /**
   * Check to see if we are in a note reference.
   */
  insideNoteRef?: boolean;
  /**
   * frontmatter variables exposed for substitution
   */
  fm?: any;
  wikiLinksOpts?: WikiLinksOpts;
  publishOpts?: DendronPubOpts;
  backlinkHoverOpts?: BacklinkOpts;
} & {
  config?: IntermediateDendronConfig;
  wsRoot?: string;
};

/**
 * Data from the processor
 */
export type ProcDataFullV5 = {
  // main properties that are configured when processor is created
  engine: DEngineClient;
  vault: DVault;
  fname: string;
  dest: DendronASTDest;
  wsRoot: string;

  // derived: unless passed in, these come from engine or are set by
  // other unified plugins
  config: IntermediateDendronConfig;
  notes?: NotePropsByIdDict;
  insideNoteRef?: boolean;

  fm?: any;
  /**
   * Keep track of current note ref level
   */
  noteRefLvl: number;
};

function checkProps({
  requiredProps,
  data,
}: {
  requiredProps: string[];
  data: any;
}): { valid: true } | { valid: false; missing: string[] } {
  const hasAllProps = _.map(requiredProps, (prop) => {
    // @ts-ignore
    return !_.isUndefined(data[prop]);
  });
  if (!_.every(hasAllProps)) {
    // @ts-ignore
    const missing = _.filter(requiredProps, (prop) =>
      // @ts-ignore
      _.isUndefined(data[prop])
    );
    return { valid: false, missing };
  }
  return { valid: true };
}

export class MDUtilsV5 {
  static getProcOpts(proc: Processor): ProcOptsV5 {
    const _data = proc.data("dendronProcOptsv5") as ProcOptsV5;
    return _data || {};
  }

  static getProcData(proc: Processor): ProcDataFullV5 {
    let _data = proc.data("dendronProcDatav5") as ProcDataFullV5;
    return _data || {};
  }

  static setNoteRefLvl(proc: Processor, lvl: number) {
    return this.setProcData(proc, { noteRefLvl: lvl });
  }

  static setProcData(proc: Processor, opts: Partial<ProcDataFullV5>) {
    const _data = proc.data("dendronProcDatav5") as ProcDataFullV5;
    const notes = _.isUndefined(opts.notes) ? opts?.engine?.notes : opts.notes;
    return proc.data("dendronProcDatav5", { ..._data, ...opts, notes });
  }

  static setProcOpts(proc: Processor, opts: ProcOptsV5) {
    const _data = proc.data("dendronProcOptsv5") as ProcOptsV5;
    return proc.data("dendronProcOptsv5", { ..._data, ...opts });
  }

  static isV5Active(proc: Processor) {
    return !_.isUndefined(this.getProcOpts(proc).mode);
  }

  static shouldApplyPublishingRules(proc: Processor): boolean {
    return (
      this.getProcData(proc).dest === DendronASTDest.HTML &&
      this.getProcOpts(proc).flavor === ProcFlavor.PUBLISHING
    );
  }

  static getFM(opts: { note: NoteProps }) {
    const { note } = opts;
    const custom = note.custom ? note.custom : undefined;
    return {
      ...custom,
      id: note.id,
      title: note.title,
      desc: note.desc,
      created: note.created,
      updated: note.updated,
    };
  }

  /**
   * Used for processing a Dendron markdown note
   */
  static _procRemark(opts: ProcOptsV5, data: Partial<ProcDataFullOptsV5>) {
    const errors: DendronError[] = [];
    opts = _.defaults(opts, { flavor: ProcFlavor.REGULAR });
    let proc = remark()
      .use(remarkParse, { gfm: true })
      .use(frontmatterPlugin, ["yaml"])
      .use(abbrPlugin)
      .use({ settings: { listItemIndent: "1", fences: true, bullet: "-" } })
      .use(noteRefsV2)
      .use(blockAnchors)
      .use(hashtags)
      .use(userTags)
      .use(extendedImage)
      .use(footnotes)
      .use(variables)
      .use(backlinksHover, data.backlinkHoverOpts)
      .data("errors", errors);

    //do not convert wikilinks if convertLinks set to false. Used by gdoc export pod. It uses HTMLPublish pod to do the md-->html conversion
    if (
      _.isUndefined(data.wikiLinksOpts?.convertLinks) ||
      data.wikiLinksOpts?.convertLinks
    ) {
      proc = proc.use(wikiLinks, data.wikiLinksOpts);
    }

    // set options and do validation
    proc = this.setProcOpts(proc, opts);

    switch (opts.mode) {
      case ProcMode.FULL:
        {
          if (_.isUndefined(data)) {
            throw DendronError.createFromStatus({
              status: ERROR_STATUS.INVALID_CONFIG,
              message: `data is required when not using raw proc`,
            });
          }
          const requiredProps = ["vault", "engine", "fname", "dest"];
          const resp = checkProps({ requiredProps, data });
          if (!resp.valid) {
            throw DendronError.createFromStatus({
              status: ERROR_STATUS.INVALID_CONFIG,
              message: `missing required fields in data. ${resp.missing.join(
                " ,"
              )} missing`,
            });
          }
          if (!data.config) {
            data.config = data.engine!.config;
          }
          if (!data.wsRoot) {
            data.wsRoot = data.engine!.wsRoot;
          }

          const note = NoteUtils.getNoteByFnameFromEngine({
            fname: data.fname!,
            engine: data.engine!,
            vault: data.vault!,
          });

          if (!_.isUndefined(note)) {
            proc = proc.data("fm", this.getFM({ note }));
          }

          this.setProcData(proc, data as ProcDataFullV5);

          // NOTE: order matters. this needs to appear before `dendronPub`
          if (data.dest === DendronASTDest.HTML) {
            //do not convert backlinks, children if convertLinks set to false. Used by gdoc export pod. It uses HTMLPublish pod to do the md-->html conversion
            if (
              _.isUndefined(data.wikiLinksOpts?.convertLinks) ||
              data.wikiLinksOpts?.convertLinks
            ) {
              proc = proc.use(hierarchies).use(backlinks);
            }
          }
          // Add flavor specific plugins. These need to come before `dendronPub`
          // to fix extended image URLs before they get converted to HTML
          if (opts.flavor === ProcFlavor.PREVIEW) {
            // No extra plugins needed for the preview right now. We used to
            // need a plugin to rewrite URLs to get the engine to proxy images,
            // but now that's done by the
            // [[PreviewPanel|../packages/plugin-core/src/components/views/PreviewPanel.ts#^preview-rewrites-images]]
          }
          if (
            opts.flavor === ProcFlavor.HOVER_PREVIEW ||
            opts.flavor === ProcFlavor.BACKLINKS_PANEL_HOVER
          ) {
            proc = proc.use(dendronHoverPreview);
          }
          // add additional plugins
          const isNoteRef = !_.isUndefined((data as ProcDataFullV5).noteRefLvl);
          let insertTitle;
          if (isNoteRef || opts.flavor === ProcFlavor.BACKLINKS_PANEL_HOVER) {
            insertTitle = false;
          } else {
            const config = data.config as IntermediateDendronConfig;
            const shouldApplyPublishRules =
              MDUtilsV5.shouldApplyPublishingRules(proc);
            insertTitle = ConfigUtils.getEnableFMTitle(
              config,
              shouldApplyPublishRules
            );
          }
          const config = data.config as IntermediateDendronConfig;
          const publishingConfig = ConfigUtils.getPublishingConfig(config);
          const assetsPrefix = publishingConfig.assetsPrefix;

          proc = proc.use(dendronPub, {
            insertTitle,
            transformNoPublish: opts.flavor === ProcFlavor.PUBLISHING,
            ...data.publishOpts,
          });

          const shouldApplyPublishRules =
            MDUtilsV5.shouldApplyPublishingRules(proc);

          if (ConfigUtils.getEnableKatex(config, shouldApplyPublishRules)) {
            proc = proc.use(math);
          }
          if (ConfigUtils.getEnableMermaid(config, shouldApplyPublishRules)) {
            proc = proc.use(mermaid, { simple: true });
          }
          // Add remaining flavor specific plugins
          if (opts.flavor === ProcFlavor.PUBLISHING) {
            const prefix = assetsPrefix ? assetsPrefix + "/notes/" : "/notes/";
            proc = proc.use(dendronPub, {
              wikiLinkOpts: {
                prefix,
              },
            });
          }
        }
        break;
      case ProcMode.IMPORT: {
        const requiredProps = ["vault", "engine", "dest"];
        const resp = checkProps({ requiredProps, data });
        if (!resp.valid) {
          throw DendronError.createFromStatus({
            status: ERROR_STATUS.INVALID_CONFIG,
            message: `missing required fields in data. ${resp.missing.join(
              " ,"
            )} missing`,
          });
        }
        if (!data.config) {
          data.config = data.engine!.config;
        }
        if (!data.wsRoot) {
          data.wsRoot = data.engine!.wsRoot;
        }

        // backwards compatibility, default to v4 values
        this.setProcData(proc, data as ProcDataFullV5);

        // add additional plugins
        const config = data.config as IntermediateDendronConfig;
        const shouldApplyPublishRules =
          MDUtilsV5.shouldApplyPublishingRules(proc);

        if (ConfigUtils.getEnableKatex(config, shouldApplyPublishRules)) {
          proc = proc.use(math);
        }

        if (ConfigUtils.getEnableMermaid(config, shouldApplyPublishRules)) {
          proc = proc.use(mermaid, { simple: true });
        }
        break;
      }
      case ProcMode.NO_DATA:
        break;
      default:
        assertUnreachable(opts.mode);
    }
    return proc;
  }

  static _procRehype(opts: ProcOptsV5, data?: Partial<ProcDataFullOptsV5>) {
    const pRemarkParse = this.procRemarkParse(opts, {
      ...data,
      dest: DendronASTDest.HTML,
    });

    // add additional plugin for publishing
    let pRehype = pRemarkParse
      .use(remark2rehype, {
        allowDangerousHtml: true,
        handlers: {
          table: HastUtils.table,
        },
      })
      .use(rehypePrism, { ignoreMissing: true })
      .use(raw)
      .use(slug);

    // apply plugins enabled by config
    const config = data?.engine?.config as IntermediateDendronConfig;
    const shouldApplyPublishRules =
      MDUtilsV5.shouldApplyPublishingRules(pRehype);
    if (ConfigUtils.getEnableKatex(config, shouldApplyPublishRules)) {
      pRehype = pRehype.use(katex);
    }
    // apply publishing specific things
    if (shouldApplyPublishRules) {
      pRehype = pRehype.use(link, {
        properties: {
          "aria-hidden": "true",
          class: "anchor-heading icon-link",
        },
        content: {
          type: "text",
          // @ts-ignore
          value: "",
        },
      });
    }
    return pRehype;
  }

  static procRemarkFull(
    data: ProcDataFullOptsV5,
    opts?: { mode?: ProcMode; flavor?: ProcFlavor }
  ) {
    return this._procRemark(
      {
        mode: opts?.mode || ProcMode.FULL,
        flavor: opts?.flavor || ProcFlavor.REGULAR,
      },
      data
    );
  }

  /**
   * Parse Dendron Markdown Note. No compiler is attached.
   * @param opts
   * @param data
   * @returns
   */
  static procRemarkParse(opts: ProcOptsV5, data: Partial<ProcDataFullOptsV5>) {
    return this._procRemark({ ...opts, parseOnly: true }, data);
  }

  /**
   * Equivalent to running {@link procRemarkParse({mode: ProcMode.NO_DATA})}
   *
   * Warning! When using a no-data parser, any user configuration will not be
   * available. Avoid using it unless you are sure that the user configuration
   * has no effect on what you are doing.
   */
  static procRemarkParseNoData(
    opts: Omit<ProcOptsV5, "mode" | "parseOnly">,
    data: Partial<ProcDataFullOptsV5> & { dest: DendronASTDest }
  ) {
    return this._procRemark(
      { ...opts, parseOnly: true, mode: ProcMode.NO_DATA },
      data
    );
  }

  /**
   * Equivalent to running {@link procRemarkParse({mode: ProcMode.FULL})}
   */
  static procRemarkParseFull(
    opts: Omit<ProcOptsV5, "mode" | "parseOnly">,
    data: ProcDataFullOptsV5
  ) {
    return this._procRemark(
      { ...opts, parseOnly: true, mode: ProcMode.FULL },
      data
    );
  }

  static procRehypeParse(opts: ProcOptsV5, data?: Partial<ProcDataFullOptsV5>) {
    return this._procRemark(
      { ...opts, parseOnly: true },
      { ...data, dest: DendronASTDest.HTML }
    );
  }

  static procRehypeFull(
    data: Omit<ProcDataFullOptsV5, "dest">,
    opts?: { flavor?: ProcFlavor }
  ) {
    const proc = this._procRehype(
      { mode: ProcMode.FULL, parseOnly: false, flavor: opts?.flavor },
      data
    );
    return proc.use(rehypeStringify);
  }
}

var own = {}.hasOwnProperty;

class HastUtils {
  // Transform an unknown node.
  static unknown(h: any, node: any) {
    if (HastUtils.text(node)) {
      return h.augment(node, u("text", node.value));
    }

    return h(node, "div", HastUtils.all(h, node));
  }

  // Visit a node.
  static one(h: any, node: any, parent: any) {
    var type = node && node.type;
    var fn = own.call(h.handlers, type) ? h.handlers[type] : null;

    // Fail on non-nodes.
    if (!type) {
      throw new Error("Expected node, got `" + node + "`");
    }

    return (typeof fn === "function" ? fn : HastUtils.unknown)(h, node, parent);
  }

  // Check if the node should be renderered as a text node.
  static text(node: any) {
    var data = node.data || {};

    if (
      own.call(data, "hName") ||
      own.call(data, "hProperties") ||
      own.call(data, "hChildren")
    ) {
      return false;
    }

    return "value" in node;
  }

  static all(h: any, parent: any) {
    var nodes = parent.children || [];
    var length = nodes.length;
    var values: any[] = [];
    var index = -1;
    var result;
    var head;

    while (++index < length) {
      result = HastUtils.one(h, nodes[index], parent);

      if (result) {
        if (index && nodes[index - 1].type === "break") {
          if (result.value) {
            result.value = result.value.replace(/^\s+/, "");
          }

          head = result.children && result.children[0];

          if (head && head.value) {
            head.value = head.value.replace(/^\s+/, "");
          }
        }

        values = values.concat(result);
      }
    }

    return values;
  }

  // Wrap `nodes` with line feeds between each entry.
  // Optionally adds line feeds at the start and end.
  static wrap(nodes: any, loose: any) {
    var result = [];
    var index = -1;
    var length = nodes.length;

    if (loose) {
      result.push(u("text", "\n"));
    }

    while (++index < length) {
      if (index) {
        result.push(u("text", "\n"));
      }

      result.push(nodes[index]);
    }

    if (loose && nodes.length !== 0) {
      result.push(u("text", "\n"));
    }

    return result;
  }

  static table(h: any, node: any) {
    var rows = node.children;
    var index = rows.length;
    var align = node.align;
    var alignLength = align.length;
    var result = [];
    var pos;
    var row;
    var out;
    var name;
    var cell;

    while (index--) {
      row = rows[index].children;
      name = index === 0 ? "th" : "td";
      pos = alignLength;
      out = [];

      while (pos--) {
        cell = row[pos];
        out[pos] = h(
          cell,
          name,
          { align: align[pos] },
          cell ? HastUtils.all(h, cell) : []
        );
      }

      result[index] = h(rows[index], "tr", HastUtils.wrap(out, true));
    }

    return h(
      node,
      "table",
      HastUtils.wrap(
        [
          h(result[0].position, "thead", HastUtils.wrap([result[0]], true)),
          h(
            {
              start: position.start(result[1]),
              end: position.end(result[result.length - 1]),
            },
            "tbody",
            HastUtils.wrap(result.slice(1), true)
          ),
        ],
        true
      )
    );
  }
}
