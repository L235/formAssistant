// <nowiki>
/*  [[Mediawiki:Form-assistant.js]]
    @author: L235 ([[User:L235]])

    This script is a form assistant that allows users to submit forms on Wikipedia pages, 
    the answers to which are then posted to a target page.

    Data is stored in a JSON file found at [[Mediawiki:Form-assistant.js/config.json]].

    The form assistant is only available on the [[Wikipedia:Form assistant/Run]] page.

    **JSON schema (examples)**

    Object‑key style:
    {
      "Wikipedia:Form assistant/Run#demo": {
        "title": "Demo survey",
        "instructions": "Please fill the survey.",
        "targetPage": "Wikipedia:Sandbox",
        "prepend": false,
        "onComplete": "Wikipedia:Thank‑you"       – simple string -> redirect
          // or: { "redirectPage": "Wikipedia:Foo" }
          // or: { "text": "''Thanks!''" }   – show wikitext message
          // or: { "html": "<b>Thanks!</b>" } – show raw HTML (use with care)
        "preview": "button",
        "template": { "name": "Template:Example", "subst": true },
        "questions": [
          { "label": "Question A", "type": "text", "templateParam": "1", "default": "foo", "preview": "live" },
          { "label": "Question B", "type": "textarea", "required": true, "templateParam": "2" },
          { "type": "heading", "text": "Choices" },
          { "label": "Question C", "type": "dropdown", "options": ["apples", "bananas"], "templateParam": "3", "default": "bananas" },
          { "label": "Question D", "type": "checkbox", "options": ["cats", "dogs"], "templateParam": "4", "default": ["cats"] },
          { "label": "Question E", "type": "radio", "options": ["noun", "verb"], "required": true, "templateParam": "5", "default": "verb" },
          { "label": "Section title", "type": "text", "required": true, "templateParam": "6" },
          { "type": "static": "''Thanks for participating!''" }
        ]
      }
    }

    **Form Flow and Conditional Visibility**
    Questions can be conditionally shown/hidden based on answers to other questions:
    {
      "label": "Describe your pet",
      "type": "textarea",
      "templateParam": "PET_DESC",
      "required": true,
      "visibleIf": { "field": "PET_HAS", "value": "Yes" }
    }
    
    The visibleIf rule supports:
    - field: references either templateParam or internal field name
    - value: string or array of strings to match against
    - Hidden fields are automatically disabled and excluded from validation
    
    **Target page variables:**
    - {{USERNAME}} - Current user's username
    - {{FIELD:templateParam}} - Value from form field (use templateParam as identifier)
    
    **Form options:**
    - "prepend": true/false - Whether to prepend (true) or append (false, default) to target page
    - "preview": Toggle full‑form preview area at bottom of form
      Values (form‑wide or per‑question):
        • "none"   – (default) no preview
        • "live"   – live preview that updates as you type
        • "button" – adds a preview button (form bottom or just after the question)
      (individual questions may set "preview": "live"/"button" for previewing an answer)
    
    Examples:
    - "targetPage": "User talk:{{USERNAME}}" - Posts to current user's talk page
    - "targetPage": "User:{{FIELD:1}}/requests" - Uses value from templateParam "1"
    - "prepend": true - Adds content to top of page instead of bottom
*/
/* global mw, $ */
(function () {
    var CONFIG_PAGE = 'Mediawiki:Form-assistant.js/config.json';
    var ALLOWED_BASE_PAGE = 'Wikipedia:Form assistant/Run';

    mw.loader.using(['mediawiki.api', 'oojs-ui', 'mediawiki.ui.button']).then(function () {
        // Abort early if not on the permitted base page
        var fullPageTitle = mw.config.get('wgPageName').replace(/_/g, ' '); // keeps spaces
        var basePageTitle = fullPageTitle.split('#')[0]; // drop fragment if any
        if (basePageTitle !== ALLOWED_BASE_PAGE) {
            console.log('[form-assistant.js] Not on the permitted base page');
            return; // Silently exit – nothing to do here
        }

        var api = new mw.Api();

        /* ---------- internal‑field counter ------------------------ */
        var mfCounter = 0;

        /* ---------- helper: preview‑mode coercion ------------------ */
        function normalizePreviewMode(v) {
            if (v === 'live' || v === 'button' || v === 'none') return v;
            return 'none';
        }

        /* ---------- helper: debounce ------------------------------ */
        // Returns a function that delays invoking the provided function until after
        // 'wait' milliseconds have elapsed since the last time it was invoked.
        // This is particularly useful for rate-limiting events that occur in quick succession,
        // such as input events during typing.
        function debounce(fn, wait) {
            var t;
            return function () {
                var ctx = this, args = arguments;
                clearTimeout(t);
                t = setTimeout(function () { fn.apply(ctx, args); }, wait);
            };
        }

        /* ---------- helper: build wikitext from answers -------------- */
        function buildWikitext($form, cfg) {
            var params = (cfg.questions || []).filter(function (q) { return q.templateParam; })
                .map(function (q) { return '|' + q.templateParam + '=' + encodeParam(valueOf($form, q)); }).join('');
            var tpl = cfg.template.name || cfg.template;
            if (cfg.template && cfg.template.subst) tpl = 'safesubst:' + tpl;
            return '\n{{' + tpl + params + '}}\n';
        }

        /* ---------- helper: parse wikitext -> safe HTML -------------- */
        function parseWikitext(wt, title) {
            var params = {
                action: 'parse',
                text: wt || '',
                pst: true,                // expand templates
                contentmodel: 'wikitext',
                wrapoutputclass: '',
                disableeditsection: true      // suppress [edit] links inside parsed headings
            };
            if (title) params.title = title;  // give correct namespace context

            return api.post(params).then(function (d) {
                return d.parse.text['*'];
            }).catch(function () {
                // Never inject raw fallback – escape instead
                return $('<div>').text(wt || '').prop('outerHTML');
            });
        }

        /* ---------- helper: escape template parameters --------------- */
        function encodeParam(val) {
            // Ensure string, escape HTML special chars, preserve newlines
            return mw.html.escape(String(val || '')).replace(/\n/g, '&#10;');
        }

        /* ---------- 1. Load JSON config ------------------------------ */
        api.get({
            action: 'query', prop: 'revisions', titles: CONFIG_PAGE,
            rvprop: 'content', formatversion: 2
        }).then(function (data) {
            var page = data.query.pages[0];
            if (!page.revisions) {
                console.error('[form-assistant.js] Config page missing or empty');
                return;
            }
            var raw = page.revisions[0].content;
            var cfg;
            try { cfg = JSON.parse(raw); }
            catch (e) { console.error('[form-assistant.js] JSON parse error:', e); return; }

            // Derive current page key, supporting #section fragments
            var pageTitle = mw.config.get('wgPageName').replace(/_/g, ' ');
            var fragment = (window.location.hash || '').slice(1); // keep underscores
            var currentFull = fragment ? pageTitle + '#' + fragment : pageTitle;

            // Attempt exact match with fragment first, then without
            var formCfg = matchForm(cfg, currentFull) || matchForm(cfg, pageTitle);
            if (formCfg) renderForm(formCfg);
        }).fail(function (err) { console.error('[form-assistant.js] API error:', err); });

        /* ---------- helper: find config for this page ---------------- */
        function matchForm(cfg, page) {
            if (Array.isArray(cfg)) return cfg.find(function (f) { return f.formPage === page; });
            if (cfg[page]) return cfg[page];
            return Object.values(cfg).find(function (f) { return f.formPage === page; });
        }

        /* ---------- 2. Render form ----------------------------------- */
        function renderForm(cfg) {
            /* ---------- 0. Inject author‑supplied CSS --------------- */
            if (cfg.customCSS) {
                // cfg.customCSS is a raw CSS string – load it once per form
                mw.util.addCSS(cfg.customCSS);
            }

            $('#firstHeading').empty();
            var $content = $('#mw-content-text').empty();
            if (cfg.title) $content.append($('<h2>').text(cfg.title));

            /* ---------- generate safe field names ----------------- */
            (cfg.questions || []).forEach(function (q) {
                q._fieldName = 'mf_' + (mfCounter++);
            });

            var promises = [];
            if (cfg.instructions) {
                promises.push(parseWikitext(cfg.instructions, cfg.formPage).then(function (html) { $content.append($(html)); }));
            }

            Promise.all(promises).then(function () {
                /* ---------- 1. Wrapper for whole form -------------- */
                var $formWrapper = $('<div>')
                    .addClass('fa-form-wrapper')
                    .appendTo($content);

                var $form = $('<form>')
                    .addClass('fa-form')
                    .appendTo($formWrapper);

                (cfg.questions || []).forEach(function (q) { insertItem($form, q); });

                /* ---------- 2a. Conditional visibility ------------ */
                attachVisibilityHandlers($form, cfg);

                /* ---------- 3. Pretty blue submit button ----------- */
                var $submit = $('<button>')
                    .addClass('mw-ui-button mw-ui-progressive fa-submit')
                    .attr('type', 'submit')
                    .text('Submit');

                $form.append($submit);

                /* ---------- 4. Optional full‑form preview ---------- */
                var formPreviewMode = normalizePreviewMode(cfg.preview);
                var $previewBtn, $previewArea;

                if (formPreviewMode !== 'none') {
                    $previewBtn = $('<button>')
                        .addClass('mw-ui-button fa-preview-btn')
                        .attr('type', 'button')
                        .css({ marginLeft: '8px' })
                        .text('Preview');

                    $previewArea = $('<div>')
                        .addClass('fa-form-preview')
                        .css({ border: '1px solid #a2a9b1', padding: '8px', marginTop: '8px' });

                    // Insert elements
                    if (formPreviewMode === 'button') {
                        $form.append($previewBtn, $previewArea);
                        $previewBtn.on('click', function () {
                            var formData   = collectFormData($form, cfg);
                            var wikitext   = buildWikitext($form, cfg);
                            var targetPage = resolveTargetPage(cfg.targetPage, formData);
                            parseWikitext(wikitext, targetPage).then(function (html) {
                                $previewArea.html(html);
                            });
                        });
                    } else { // live
                        $form.append($previewArea);
                        var updateFormPreview = debounce(function () {
                            var formData   = collectFormData($form, cfg);
                            var wikitext   = buildWikitext($form, cfg);
                            var targetPage = resolveTargetPage(cfg.targetPage, formData);
                            parseWikitext(wikitext, targetPage).then(function (html) {
                                $previewArea.html(html);
                            });
                        }, 500);
                        // listen to *all* inputs in the form
                        $form.on('input change', 'input, textarea, select', updateFormPreview);
                        updateFormPreview(); // initial render (includes defaults)
                    }
                }

                $form.on('submit', function (e) {
                    e.preventDefault();
                    submit($form, cfg, $submit);
                });
            });
        }

        /* ---------- insert question or static block ------------------ */
        function insertItem($form, q) {
            var safeName = q._fieldName;   // always defined for non‑static items

            switch (q.type) {
                case 'heading':
                    q._$wrapper = $('<h3>')
                        .addClass('fa-heading')
                        .text(q.text)
                        .appendTo($form);
                    return;
                case 'static':
                case 'html':
                    /* place synchronous placeholder so visibility can act immediately */
                    var $ph = $('<div class="formassistant-placeholder fa-static"></div>');
                    q._$wrapper = $ph;            /* <- make wrapper available right now */
                    $form.append($ph);            /* preserves ordering */
                    parseWikitext(q.html || q.text || '', q.formPage)
                        .then(function (html) {
                            // Ensure final output retains styling class
                            var $final   = $(html).addClass('fa-static');
                            /* keep whatever visibility state the placeholder had */
                            if (!$ph.is(':visible')) { $final.hide(); }

                            q._$wrapper = $final;  /* swap to real wrapper */
                            $ph.replaceWith($final);
                        });
                    return;
            }

            var $wrapper = $('<div>').addClass('fa-question');

            var $label = $('<label>')
                .addClass('fa-question-label')
                .text(q.label + (q.required ? ' (required)' : ''));
            var $field;

            switch (q.type) {
                case 'text':
                    $field = $('<input>').attr({ type: 'text', name: safeName, size: 40, value: q.default || '' });
                    break;
                case 'textarea':
                    $field = $('<textarea>').attr({ name: safeName, rows: 4, cols: 60 }).val(q.default || '');
                    break;
                case 'dropdown':
                    $field = $('<select>').attr('name', safeName);
                    (q.options || []).forEach(function (opt) {
                        var $o = $('<option>').val(opt).text(opt);
                        if (opt === q.default) $o.prop('selected', true);
                        $field.append($o);
                    });
                    break;
                case 'checkbox':
                    $field = $('<span>');
                    var defs = Array.isArray(q.default) ? q.default : (q.default ? [q.default] : []);
                    // Add initial line break for vertical layout
                    if (q.vertical) {
                        $field.append('<br>');
                    }
                    (q.options || []).forEach(function (opt) {
                        var $l = $('<label>');
                        var $cb = $('<input>').attr({ type: 'checkbox', name: safeName, value: opt });
                        if (defs.includes(opt)) $cb.prop('checked', true);
                        $l.append($cb, ' ', opt);
                        // Add line break if vertical layout is requested
                        if (q.vertical) {
                            $l.append('<br>');
                        } else {
                            $l.append('\u00A0'); // non-breaking space for horizontal layout
                        }
                        $field.append($l);
                    });
                    break;
                case 'radio':
                    $field = $('<span>');
                    (q.options || []).forEach(function (opt) {
                        var $l = $('<label>');
                        var $rb = $('<input>').attr({ type: 'radio', name: safeName, value: opt });
                        if (q.required) $rb.attr('required', true);
                        if (opt === q.default) $rb.prop('checked', true);
                        $l.append($rb, ' ', opt, '\u00A0');
                        $field.append($l);
                    });
                    break;
                default:
                    console.warn('[form-assistant.js] Unsupported field type:', q.type);
                    return;
            }

            /* ------------ accessibility annotations --------------- */
            var fieldId = safeName + '_input';
            $field.attr('id', fieldId);
            $label.attr('for', fieldId);
            if (q.required) {
                $field.attr({ required: true, 'aria-required': 'true' });
            }
            if (['checkbox', 'radio'].includes(q.type)) {
                $field.attr({ role: 'group', 'aria-labelledby': fieldId + '_lbl' });
                $label.attr('id', fieldId + '_lbl');
            }

            $wrapper.append($label, ' ', $field.addClass('fa-question-input'));

            /* store for visibility rules */
            q._$wrapper = $wrapper;

            /* ---------- per‑question live preview ---------------- */
            var qPrevMode = normalizePreviewMode(q.preview);

            if (qPrevMode !== 'none' && ['text', 'textarea'].includes(q.type)) {
                var $qPrev = $('<div>')
                    .addClass('fa-field-preview')
                    .css({ border: '1px solid #c8ccd1', padding: '4px', marginTop: '4px' });

                var updateFieldPreview = debounce(function () {
                    var val = ($field.val() || '').trim();
                    if (!val) { $qPrev.empty(); return; }
                    parseWikitext(val, q.formPage).then(function (html) { $qPrev.html(html); });
                }, 500);

                if (qPrevMode === 'live') {
                    $field.on('input', updateFieldPreview);
                    updateFieldPreview(); // initial render
                    $wrapper.append($qPrev);
                } else { // button
                    var $btnPrev = $('<button>')
                        .addClass('mw-ui-button fa-q-preview-btn')
                        .attr('type', 'button')
                        .text('Preview');
                    $btnPrev.on('click', updateFieldPreview);
                    $wrapper.append(' ', $btnPrev, $qPrev);
                }
            }

            $form.append($wrapper);
        }

        /* ---------- helper: conditional visibility ------------------ */
        function attachVisibilityHandlers($form, cfg) {
            function resolveController(fieldRef) {
                return (cfg.questions || []).find(function (qq) {
                    return qq.templateParam === fieldRef || qq._fieldName === fieldRef;
                });
            }

            /* evaluate a single rule */
            function shouldShow(rule, ctrlVal) {
                if (rule == null) return true; // no rule
                /* rule: { field: "PARAM", value: "foo" } or value: ["a","b"] */
                var expected = rule.value;
                if (Array.isArray(expected)) {
                    return expected.includes(ctrlVal);
                }
                return ctrlVal === expected;
            }

            /* set wrapper visibility + enable/disable underlying fields */
            function setVisible($w, on) {
                if (!$w) return;
                if (on) {
                    $w.show().find('input,select,textarea').prop('disabled', false);
                } else {
                    $w.hide().find('input,select,textarea').prop('disabled', true);
                }
            }

            (cfg.questions || []).forEach(function (q) {
                if (!q.visibleIf) return; // nothing to do

                var rule  = q.visibleIf;
                var ctrlQ = resolveController(rule.field);
                if (!ctrlQ) {
                    console.warn('[form‑assistant.js] visibleIf: controller not found for', rule);
                    return;
                }

                var sel = '[name="' + ctrlQ._fieldName + '"]';
                function update() {
                    var v  = valueOf($form, ctrlQ);
                    var ok = shouldShow(rule, v);
                    setVisible(q._$wrapper, ok);
                }

                $form.on('change input', sel, update);
                update(); // initial
            });
        }

        /* ---------- helper: resolve target page variables ----------- */
        function resolveTargetPage(targetPage, formData) {
            if (!targetPage || typeof targetPage !== 'string') return targetPage;
            
            // Replace {{USERNAME}} with current user
            var resolved = targetPage.replace(/\{\{USERNAME\}\}/g, mw.config.get('wgUserName') || '');
            
            // Replace {{FIELD:fieldname}} with form field values
            resolved = resolved.replace(/\{\{FIELD:([^}]+)\}\}/g, function(match, fieldName) {
                return formData[fieldName] || match;
            });
            
            return resolved;
        }

        /* ---------- 3. Submission ------------------------------------ */
        function valueOf($form, q) {
            var sel = '[name="' + q._fieldName + '"]';
            switch (q.type) {
                case 'checkbox':
                    return $form.find(sel + ':checked').map(function () { return this.value; }).get().join(', ');
                case 'radio':
                    return $form.find(sel + ':checked').val() || '';
                default:
                    return ($form.find(sel).val() || '').trim();
            }
        }

        /* ---------- helper: collect form data ----------------------- */
        function collectFormData($form, cfg) {
            var data = {};
            (cfg.questions || []).forEach(function (q) {
                if (q.templateParam) data[q.templateParam] = valueOf($form, q);
            });
            return data;
        }

        function submit($form, cfg, $submit) {
            // Collect all form data for target page resolution
            var formData = collectFormData($form, cfg);

            // Custom validation for required checkbox groups
            var missing = (cfg.questions || []).filter(function (q) {
                if (!q.required) return false;
                if (q._$wrapper && !q._$wrapper.is(':visible')) return false; // only if visible
                var val = valueOf($form, q);
                return !val; // empty string means nothing selected
            });

            if (missing.length) {
                alert('Please complete required fields: ' + missing.map(function (q) { return q.label; }).join(', '));
                return;
            }

            var wikitext = buildWikitext($form, cfg);

            // Resolve target page with variables
            var targetPage = resolveTargetPage(cfg.targetPage, formData);

            $submit.prop('disabled', true).val('Submitting…');
            
            // Determine edit parameters based on prepend option
            var editParams = {
                action: 'edit',
                title: targetPage,
                summary: cfg.editSummary || 'Post answers via [[Mediawiki:form-assistant.js|form-assistant.js]]'
            };
            
            if (cfg.prepend) {
                editParams.prependtext = wikitext;
            } else {
                editParams.appendtext = wikitext;
            }
            
            api.postWithToken('csrf', editParams).done(function () {
                /* ---------- post‑submit action ------------------ */
                function replaceFormWithMessage() {
                    // Clear entire content area and inject parsed message
                    var $content = $('#mw-content-text').empty();
                    parseWikitext(cfg.onComplete.html || cfg.onComplete.text || '', cfg.formPage)
                        .then(function (html) { $content.append($(html)); });
                }

                if (cfg.onComplete) {
                    // 1. Simple string → redirect
                    if (typeof cfg.onComplete === 'string') {
                        window.location.href = mw.util.getUrl(cfg.onComplete);
                        return;
                    }
                    // 2. Explicit redirect object
                    if (cfg.onComplete.redirectPage) {
                        window.location.href = mw.util.getUrl(cfg.onComplete.redirectPage);
                        return;
                    }
                    // 3. Static/html message
                    if (cfg.onComplete.text || cfg.onComplete.html) {
                        replaceFormWithMessage();
                        return;
                    }
                }

                // Default behaviour if no onComplete directive
                mw.notify('Saved!', { type: 'success' });
                $form[0].reset();
            }).fail(function (err) {
                console.error('[formFiller.js] Edit error:', err);
                mw.notify('Error: ' + err, { type: 'error', autoHide: false });
            }).always(function () {
                $submit.prop('disabled', false).val('Submit');
            });
        }
    });
})();

// </nowiki>
