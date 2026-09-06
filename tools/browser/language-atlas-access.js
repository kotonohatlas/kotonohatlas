/* Kotonohatlas country/language access model. */
/* Access-based locale suggestions */
const LocaleAccess = (() => {
	/* Default: built site ships locale-context.php; Workers may own /locale-context*. */
	const COUNTRY_ENDPOINT = '/locale-context.php';
	const COUNTRY_CACHE_KEY = 'locale-access-country-v1';
	const COUNTRY_CACHE_TTL = 24 * 60 * 60 * 1000;

	/*
	 * Site-independent country -> language relevance.
	 * ESTABLISHED is intentionally broad but stable: national, official, regional,
	 * territorial, traditional, and other strongly location-associated written
	 * languages. Contemporary diaspora languages belong in their dedicated map;
	 * neighboring-country suggestions are derived from the land-border graph.
	 * Unsupported languages are filtered later by each site's hreflang list.
	 *
	 * The institutional inventory is audited against Unicode CLDR territoryInfo,
	 * but CLDR is not copied mechanically.  Script variants and territories that
	 * this atlas models separately remain separate (for example kl in GL), Iraqi
	 * Turkmen is not relabeled az-Arab, and obsolete legal-status records do not
	 * override current country data.
	 * https://github.com/unicode-org/cldr-json/blob/main/cldr-json/cldr-core/supplemental/territoryInfo.json
	 */
	const BASE_ESTABLISHED_LANGUAGES_BY_COUNTRY = Object.freeze({
	AD: ['ca'],
	AE: ['ar'],
	AF: ['fa-AF', 'ps', 'haz', 'uz-Arab', 'tk'],
	AG: ['en'],
	AI: ['en'],
	AL: ['sq'],
	AM: ['hy'],
	AO: ['pt-PT', 'umb', 'kmb', 'kg'],
	AR: ['es', 'gn'],
	AS: ['sm', 'en'],
	AT: ['de', 'bar', 'hr', 'sl', 'hu', 'cs', 'sk', 'rom'],
	AU: ['en'],
	AW: ['nl', 'pap'],
	AX: ['sv', 'fi'],
	AZ: ['az-Latn', 'tly'],
	BA: ['bs', 'hr', 'sr', 'rom', 'yi'],
	BB: ['en'],
	BD: ['bn', 'rkt', 'syl'],
	BE: ['nl', 'fr', 'de', 'vls', 'wa'],
	BF: ['mos', 'dyu', 'fr', 'ha', 'ff'],
	BG: ['bg', 'tr'],
	BH: ['ar'],
	BI: ['rn', 'fr', 'sw', 'en'],
	BJ: ['fr', 'fon', 'yo', 'ha', 'ff'],
	BL: ['fr'],
	BM: ['en'],
	BN: ['ms', 'ms-Arab'],
	BO: ['es', 'qu', 'ay', 'gn'],
	BQ: ['pap', 'nl', 'en'],
	BR: ['pt-BR', 'vec'],
	BS: ['en'],
	BT: ['dz', 'tsj'],
	BW: ['tn', 'en', 'kck'],
	BY: ['be', 'ru'],
	BZ: ['es', 'en'],
	CA: ['fr', 'iu', 'iu-Latn', 'crk', 'chp', 'den', 'dgr', 'gwi', 'en'],
	CC: ['en'],
	CD: ['fr', 'sw', 'lua', 'ln', 'kg'],
	CF: ['sg', 'fr'],
	CG: ['fr', 'ln'],
	CH: ['de', 'gsw', 'fr', 'it', 'rm'],
	CI: ['fr', 'bci', 'sef', 'dnj'],
	CK: ['en'],
	CL: ['es', 'arn'],
	CM: ['fr', 'bum', 'ewo', 'ha', 'en'],
	CN: ['zh-Hans', 'wuu', 'yue-Hans', 'ug', 'za', 'mn-Mong', 'bo', 'ko', 'mn', 'kk', 'ky'],
	CO: ['es', 'guc', 'pbb', 'icr'],
	CR: ['es'],
	CU: ['es'],
	CV: ['kea', 'pt-PT'],
	CW: ['pap', 'nl'],
	CX: ['en'],
	CY: ['el', 'tr', 'hy'],
	CZ: ['cs', 'rom'],
	DE: ['de', 'nds', 'vmf', 'frr', 'stq', 'hsb', 'dsb', 'da', 'rom'],
	DJ: ['fr', 'ar', 'so'],
	DK: ['da', 'de'],
	DM: ['en'],
	DO: ['es'],
	DZ: ['arq', 'ar', 'fr', 'kab'],
	EA: ['es'],
	EC: ['es', 'qu', 'qug', 'jiv'],
	EE: ['et', 'vro', 'ru'],
	EG: ['ar', 'arz', 'cop'],
	EH: ['ar'],
	ER: ['ti', 'tig', 'ar', 'ssy', 'en'],
	ES: ['es', 'ca', 'gl', 'eu', 'ast', 'oc'],
	ET: ['am', 'om', 'ti', 'sid', 'so'],
	FI: ['fi', 'sv', 'sms', 'se', 'smn', 'rom', 'tt', 'yi'],
	FJ: ['hif', 'fj', 'hi', 'en'],
	FK: ['en'],
	FM: ['chk', 'pon', 'kos', 'yap', 'uli', 'en'],
	FO: ['fo', 'da'],
	FR: ['fr', 'oc', 'br', 'co', 'eu', 'ca', 'gsw'],
	GA: ['fr', 'puu', 'fan'],
	GB: ['cy', 'ga', 'gd', 'kw', 'en'],
	GD: ['en'],
	GE: ['ka', 'xmf', 'ab', 'os'],
	GF: ['fr', 'gcr'],
	GG: ['en'],
	GH: ['ak', 'ee', 'abr', 'gur', 'ada', 'gaa', 'ha', 'en'],
	GI: ['en'],
	GL: ['kl', 'da'],
	GM: ['man', 'ff', 'wo', 'en'],
	GN: ['fr', 'man-Nkoo', 'sus', 'nqo'],
	GP: ['fr'],
	GQ: ['es', 'fan', 'fr', 'bvb', 'pt-PT'],
	GR: ['el', 'tr'],
	GS: ['en'],
	GT: ['es', 'quc'],
	GU: ['ch', 'en'],
	GW: ['pt-PT'],
	GY: ['en'],
	HK: ['zh-Hant', 'yue', 'en'],
	HN: ['es'],
	HR: ['hr', 'it', 'vec'],
	HT: ['ht', 'fr'],
	HU: ['hu', 'hy', 'rom'],
	IC: ['es'],
	ID: ['id', 'jv', 'su', 'mad', 'min'],
	IE: ['ga', 'en'],
	IL: ['he', 'ar'],
	IM: ['gv', 'en'],
	IN: ['hi', 'bn', 'te', 'mr', 'ta', 'ur', 'gu', 'kn', 'ml', 'or', 'pa-Guru', 'as', 'mai', 'ne', 'sat', 'ks', 'kok', 'sd', 'sd-Deva', 'brx', 'doi', 'mni', 'kha', 'sa', 'en'],
	IO: ['en'],
	IQ: ['ar', 'ckb', 'kmr', 'sdh', 'tr'],
	IR: ['fa-IR', 'az-Arab', 'mzn', 'glk', 'ckb', 'sdh', 'kmr', 'tk'],
	IS: ['is'],
	IT: ['it', 'fr', 'lmo', 'vec', 'de', 'sl', 'sc', 'fur', 'lld', 'ca', 'sq', 'hr', 'frp', 'el', 'oc'],
	JE: ['en'],
	JM: ['jam', 'en'],
	JO: ['apc', 'ar'],
	JP: ['ja'],
	KE: ['sw', 'ki', 'luy', 'luo', 'kam', 'kln', 'guz', 'mer', 'en'],
	KG: ['ky', 'ru'],
	KH: ['km'],
	KI: ['gil', 'en'],
	KM: ['ar', 'zdj', 'wni', 'fr'],
	KN: ['en'],
	KP: ['ko'],
	KR: ['ko'],
	KW: ['ar'],
	KY: ['en'],
	KZ: ['ru', 'kk'],
	LA: ['lo', 'kjg'],
	LB: ['apc', 'ar', 'fr'],
	LC: ['en'],
	LI: ['de', 'gsw'],
	LK: ['si', 'ta', 'en'],
	LR: ['kpe', 'en'],
	LS: ['st', 'en'],
	LT: ['lt'],
	LU: ['fr', 'lb', 'de'],
	LV: ['lv', 'ltg', 'ru'],
	LY: ['ar'],
	MA: ['ary', 'ar', 'fr', 'zgh', 'tzm', 'shi', 'shi-Latn', 'rif', 'rif-Tfng'],
	MC: ['fr'],
	MD: ['ro', 'gag', 'ru'],
	ME: ['cnr', 'sr', 'bs', 'sq', 'hr', 'rom'],
	MF: ['fr'],
	MG: ['mg', 'fr'],
	MH: ['mh', 'en'],
	MK: ['mk', 'sq'],
	ML: ['bm', 'fr', 'ffm', 'snk', 'mwk', 'ses', 'dyu'],
	MM: ['my', 'shn'],
	MN: ['mn'],
	MO: ['zh-Hant', 'yue', 'pt-PT'],
	MP: ['en', 'ch'],
	MQ: ['fr'],
	MR: ['ar', 'fr'],
	MS: ['en'],
	MT: ['mt', 'en'],
	MU: ['mfe', 'fr', 'bho', 'ur', 'en'],
	MV: ['dv'],
	MW: ['ny', 'tum', 'en'],
	MX: ['es'],
	MY: ['ms', 'zh-Hans', 'ta'],
	MZ: ['pt-PT', 'vmw', 'ndc', 'ngl', 'seh', 'mgh', 'rng'],
	NA: ['kj', 'ng', 'naq', 'hz', 'tn', 'af', 'en'],
	NC: ['fr'],
	NE: ['dje', 'fr', 'fuq', 'tmh', 'ha'],
	NF: ['en'],
	NG: ['pcm', 'ha', 'ig', 'yo', 'fuv', 'en'],
	NI: ['es'],
	NL: ['nl', 'li', 'fy', 'gos', 'rom', 'yi'],
	NO: ['nb', 'nn', 'se', 'sma', 'smj', 'fkv', 'rom'],
	NP: ['ne', 'new', 'jml'],
	NR: ['na', 'en'],
	NU: ['niu', 'en'],
	NZ: ['mi', 'en'],
	OM: ['ar'],
	PA: ['es'],
	PE: ['es', 'qu', 'ay', 'cni', 'shp'],
	PF: ['fr', 'ty'],
	PG: ['tpi', 'ho', 'en'],
	PH: ['fil', 'ceb', 'ilo', 'hil', 'bik', 'war', 'pag', 'mdh', 'tsg', 'en'],
	PK: ['ur', 'pa-Arab', 'lah', 'sd', 'skr', 'ps', 'en'],
	PL: ['pl', 'de', 'csb', 'lt', 'hy', 'rom', 'tt', 'yi'],
	PM: ['fr'],
	PN: ['en'],
	PR: ['es', 'en'],
	PS: ['apc', 'ar'],
	PT: ['pt-PT', 'mwl'],
	PW: ['pau', 'en'],
	PY: ['gn', 'es'],
	QA: ['ar'],
	RE: ['fr', 'rcf'],
	RO: ['ro', 'hu', 'hy', 'rom', 'tt', 'yi'],
	RS: ['sr', 'hu', 'ro', 'hr', 'sk', 'uk', 'rsk', 'bs', 'sq', 'bg', 'rom'],
	RU: ['ru', 'tt', 'ba', 'ce', 'av', 'udm', 'sah', 'kbd', 'myv', 'mdf', 'kum', 'kv', 'lez', 'krc', 'inh', 'tyv', 'az-Cyrl', 'ady', 'lbe', 'koi', 'os', 'yi'],
	RW: ['rw', 'fr', 'sw', 'en'],
	SA: ['ar', 'ars'],
	SB: ['pis', 'en'],
	SC: ['crs', 'fr', 'en'],
	SD: ['apd', 'ar', 'bej', 'en'],
	SE: ['sv', 'fi', 'fit', 'se', 'sma', 'smj', 'yi', 'rom'],
	SG: ['zh-Hans', 'ms', 'ta', 'en'],
	SH: ['en'],
	SI: ['sl', 'vec', 'it', 'hu', 'rom'],
	SJ: ['nb'],
	SK: ['sk', 'hu', 'rom', 'yi'],
	SL: ['kri', 'men', 'tem', 'en'],
	SM: ['it'],
	SN: ['wo', 'fr', 'ff', 'srr', 'dyo', 'sav', 'mfv', 'bjt', 'snf', 'knf', 'bsc', 'mey', 'tnr'],
	SO: ['so', 'ar'],
	SR: ['nl', 'srn'],
	SS: ['nus', 'en'],
	ST: ['pt-PT'],
	SV: ['es'],
	SX: ['vic', 'nl', 'en'],
	SY: ['apc', 'ar', 'kmr'],
	SZ: ['ss', 'en'],
	TC: ['en'],
	TD: ['ar', 'fr', 'ha'],
	TG: ['fr', 'ee', 'ha'],
	TH: ['th', 'tts', 'nod', 'sou', 'mfa'],
	TJ: ['tg', 'ru'],
	TK: ['tkl', 'en'],
	TL: ['pt-PT', 'tet'],
	TM: ['tk'],
	TN: ['aeb', 'ar', 'fr'],
	TO: ['to', 'en'],
	TR: ['tr'],
	TT: ['en'],
	TV: ['tvl', 'en'],
	TW: ['zh-Hant', 'nan-Hant', 'hak-Hant'],
	TZ: ['sw', 'suk', 'nym', 'en'],
	UA: ['uk', 'ru', 'rom', 'yi'],
	UG: ['sw', 'lg', 'nyn', 'cgg', 'xog', 'teo', 'laj', 'ach', 'en'],
	UM: ['en'],
	US: ['es', 'haw', 'en'],
	UY: ['es'],
	UZ: ['uz-Latn', 'uz-Cyrl', 'ru', 'tk'],
	VA: ['it', 'la'],
	VC: ['en'],
	VE: ['es', 'guc', 'wba', 'aoc'],
	VG: ['en'],
	VI: ['en', 'vic'],
	VN: ['vi'],
	VU: ['bi', 'fr', 'en'],
	WF: ['fr', 'wls', 'fud'],
	WS: ['sm', 'en'],
	XK: ['sq', 'sr'],
	YE: ['ar'],
	YT: ['swb', 'fr', 'buc'],
	ZA: ['zu', 'xh', 'af', 'nso', 'tn', 'st', 'ts', 'ss', 've', 'nr', 'en'],
	ZM: ['bem', 'toi', 'loz', 'nse', 'en'],
	ZW: ['sn', 'nd', 'mxc', 'kck', 'st', 'tn', 'ts', 've', 'xh', 'en'],
	});

	/*
	 * Rooted regional relationships established by the atlas's subnational
	 * geometry or curated representative-country data.  They belong in the
	 * public/regional card tier, but must not be re-exported as a whole-country
	 * language through the neighboring-country suggestion model.
	 */
	const CURATED_REGIONAL_LANGUAGES_BY_COUNTRY = Object.freeze({
		AF: ['haz', 'uz-Arab', 'tk', 'tg', 'bal'],
		AO: ['umb', 'kmb', 'kg', 'ln'],
		AR: ['gn'],
		AT: ['bar', 'cs', 'hr', 'hu', 'rom', 'sk', 'sl'],
		AZ: ['tly', 'lez', 'av'],
		BE: ['vls', 'wa'],
		BD: ['rkt', 'syl'],
		BF: ['ha', 'ff'],
		BI: ['sw'],
		BJ: ['fon', 'yo', 'ha', 'ff'],
		BG: ['tr'],
		BR: ['vec'],
		BT: ['tsj'],
		BW: ['kck'],
		CA: ['iu', 'iu-Latn', 'crk', 'chp', 'den', 'dgr', 'gwi'],
		CD: ['sw', 'lua', 'ln', 'kg', 'rw', 'rn'],
		CF: ['ln'],
		CH: ['gsw'],
		CL: ['arn'],
		CM: ['bum', 'ewo', 'ff', 'ha'],
		CN: ['bo', 'ko', 'mn', 'ug', 'wuu', 'yue-Hans', 'yue-Hant', 'za', 'mn-Mong', 'kk', 'ky'],
		CO: ['guc', 'pbb', 'icr'],
		DE: ['da', 'nds', 'dsb', 'frr', 'hsb', 'stq', 'vmf'],
		DK: ['de'],
		CG: ['ln'],
		CI: ['bci', 'sef', 'dnj'],
		DZ: ['kab'],
		EC: ['qu', 'qug', 'jiv'],
		EE: ['vro'],
		ER: ['tig', 'ssy'],
		ES: ['ast', 'ca', 'eu', 'gl', 'oc'],
		FI: ['se', 'smn', 'sms'],
		FR: ['oc', 'br', 'co', 'eu', 'ca', 'gsw', 'frp', 'de'],
		ET: ['om', 'ti', 'sid', 'so'],
		FM: ['chk', 'pon', 'kos', 'yap', 'uli'],
		GB: ['cy', 'ga', 'gd', 'kw'],
		GT: ['quc'],
		GE: ['xmf', 'ab', 'os', 'hy', 'az-Latn'],
		GA: ['puu', 'fan'],
		GH: ['ee', 'abr', 'gur', 'ada', 'gaa', 'ha'],
		GQ: ['fan', 'bvb'],
		GM: ['ff', 'wo'],
		GR: ['tr'],
		GN: ['man-Nkoo', 'sus', 'nqo', 'ff', 'kpe'],
		HR: ['it', 'vec'],
		ID: ['jv', 'su', 'mad', 'min', 'ms'],
		IN: ['bho'],
		// Iraqi law grants official status to Kurdish without privileging one
		// standard variety. Sorani and Kurmanji/Badini both have concrete regional
		// cores, so the mutually exclusive card tier should classify both alike.
		IQ: ['tr', 'ckb', 'kmr', 'sdh'],
		IR: ['az-Arab', 'mzn', 'glk', 'ckb', 'sdh', 'kmr', 'tk', 'bal'],
		IT: ['ca', 'de', 'el', 'fr', 'frp', 'fur', 'hr', 'lld', 'lmo', 'oc', 'sc', 'sl', 'sq', 'vec'],
		KE: ['ki', 'luy', 'luo', 'kam', 'kln', 'guz', 'mer', 'so'],
		KG: ['kk', 'uz-Latn', 'tg'],
		KH: ['lo'],
		KZ: ['ky', 'uz-Latn'],
		LA: ['kjg'],
		LV: ['ltg'],
		KM: ['zdj', 'wni'],
		LR: ['kpe'],
		MA: ['tzm', 'shi', 'shi-Latn', 'rif', 'rif-Tfng'],
		ML: ['ffm', 'snk', 'mwk', 'ses', 'dyu'],
		MR: ['ff', 'wo'],
		MD: ['gag'],
		MW: ['tum'],
		MY: ['th'],
		MZ: ['vmw', 'ndc', 'ngl', 'seh', 'mgh', 'rng', 'ny', 'sn', 'zu', 'ts'],
		NA: ['kj', 'ng', 'naq', 'hz', 'tn'],
		NE: ['dje', 'fuq', 'tmh'],
		NG: ['ha', 'ig', 'yo', 'fuv'],
		NP: ['new', 'jml', 'bho'],
		MM: ['shn'],
		NL: ['fy', 'gos', 'li'],
		NO: ['fkv', 'nn', 'se', 'sma', 'smj'],
		PL: ['be', 'csb', 'de', 'lt'],
		PH: ['ceb', 'ilo', 'hil', 'bik', 'war', 'pag', 'mdh', 'tsg'],
		PE: ['qu', 'ay', 'cni', 'shp'],
		PK: ['pa-Arab', 'lah', 'sd', 'skr', 'ps', 'bal'],
		PT: ['mwl'],
		RE: ['rcf'],
		RO: ['hu'],
		RS: ['bg', 'bs', 'hr', 'hu', 'ro', 'rsk', 'sk', 'sq', 'uk'],
		RU: ['ady', 'av', 'az-Cyrl', 'ba', 'ce', 'inh', 'kbd', 'kk', 'koi', 'krc', 'kum', 'kv', 'lbe', 'lez', 'mdf', 'myv', 'os', 'sah', 'tt', 'tyv', 'udm', 'yi'],
		SA: ['ars'],
		SE: ['fit', 'se', 'sma', 'smj'],
		SD: ['bej'],
		SI: ['hu', 'it', 'vec'],
		SL: ['men', 'tem'],
		SN: ['ff', 'srr', 'dyo', 'sav', 'mfv', 'bjt', 'snf', 'knf', 'bsc', 'mey', 'tnr'],
		SS: ['nus'],
		SZ: ['zu'],
		SK: ['hu'],
		SY: ['kmr'],
		TH: ['tts', 'nod', 'sou', 'mfa', 'ms', 'km', 'lo'],
		TW: ['nan-Hant', 'hak-Hant'],
		TJ: ['ky', 'uz-Latn'],
		TM: ['kk', 'uz-Latn'],
		TD: ['ha'],
		TG: ['ee', 'ha'],
		TR: ['kmr'],
		TZ: ['suk', 'nym', 'rn'],
		UG: ['lg', 'nyn', 'cgg', 'xog', 'teo', 'laj', 'ach', 'rw'],
		US: ['haw'],
		UZ: ['kk', 'ky', 'tg', 'tk'],
		VE: ['guc', 'wba', 'aoc'],
		VI: ['vic'],
		WF: ['wls', 'fud'],
		YT: ['buc'],
		ZM: ['toi', 'loz', 'nse', 'ny'],
		ZW: ['nd', 'mxc', 'kck', 'st', 'tn', 'ts', 've', 'xh', 'ny'],
	});

	/*
	 * Traditional regional and non-territorial minority languages protected by
	 * the European Charter for Regional or Minority Languages.  This table was
	 * reviewed against the Council of Europe's country/language matrix (status:
	 * 9 December 2025):
	 * https://rm.coe.int/november-2022-revised-table-languages-covered-english-/1680a8fef4
	 *
	 * Only names that map unambiguously to one of this atlas's language codes are
	 * included.  Distinct varieties such as Boyash, Lemko, Karaim, Krimchak, and
	 * Cypriot Maronite Arabic must not be silently collapsed into a broader code.
	 */
	const ECRML_LANGUAGES_BY_COUNTRY = Object.freeze({
		AM: ['de', 'el', 'kmr', 'ru', 'uk'],
		AT: ['hr', 'cs', 'hu', 'rom', 'sk', 'sl'],
		BA: ['sq', 'cs', 'de', 'hu', 'it', 'pl', 'rom', 'ro', 'sk', 'sl', 'tr', 'uk', 'yi'],
		CH: ['frp', 'fr', 'de', 'it', 'rm'],
		CY: ['hy'],
		CZ: ['hr', 'de', 'pl', 'rom', 'sk'],
		DE: ['da', 'nds', 'dsb', 'frr', 'rom', 'stq', 'hsb'],
		DK: ['de'],
		ES: ['ary', 'ast', 'eu', 'ca', 'gl', 'oc', 'pt-PT'],
		FI: ['smn', 'se', 'rom', 'ru', 'sms', 'sv', 'tt', 'yi'],
		GB: ['kw', 'ga', 'gd', 'cy'],
		HR: ['cs', 'de', 'hu', 'it', 'rsk', 'sr', 'sk', 'sl', 'uk'],
		HU: ['hy', 'bg', 'hr', 'de', 'el', 'pl', 'rom', 'ro', 'sr', 'sk', 'sl', 'uk'],
		ME: ['sq', 'bs', 'hr', 'rom'],
		NL: ['fy', 'li', 'nds', 'pap', 'rom', 'yi'],
		NO: ['fkv', 'fi', 'smj', 'se', 'rom', 'sms', 'sma'],
		PL: ['hy', 'be', 'cs', 'de', 'csb', 'lt', 'rom', 'ru', 'sk', 'tt', 'uk', 'yi'],
		RO: ['sq', 'hy', 'bg', 'hr', 'cs', 'de', 'el', 'hu', 'it', 'mk', 'pl', 'rom', 'ru', 'sr', 'sk', 'tt', 'tr', 'uk', 'yi'],
		RS: ['sq', 'bs', 'bg', 'hr', 'cs', 'de', 'hu', 'mk', 'rom', 'ro', 'rsk', 'sk', 'uk'],
		SE: ['fi', 'smj', 'fit', 'se', 'rom', 'sma', 'yi'],
		SI: ['hr', 'de', 'hu', 'it', 'rom', 'sr'],
		SK: ['bg', 'hr', 'cs', 'de', 'hu', 'pl', 'rom', 'ru', 'sr', 'uk', 'yi'],
		UA: ['be', 'bg', 'gag', 'de', 'el', 'hu', 'pl', 'rom', 'ro', 'ru', 'sk', 'yi'],
	});

	/*
	 * Rooted territorial relationships.  These are cases where a language is
	 * characteristic of a concrete part of the country, whether that position is
	 * statutory or de facto.  Non-territorial recognition and protection remain
	 * in the protected tier.  Regional relations stay visible in cards and search;
	 * the renderer may retain a faint parent-country context, but only regional
	 * geometry carries a strong fill.  They never propagate through the
	 * land-border model.
	 */
	const REGIONAL_LANGUAGES_BY_COUNTRY = Object.freeze(Object.fromEntries(
		Object.entries(CURATED_REGIONAL_LANGUAGES_BY_COUNTRY)
			.map(([country, languages]) => [country, [...languages]])
	));

	const ESTABLISHED_LANGUAGES_BY_COUNTRY = Object.freeze(Object.fromEntries(
		Array.from(new Set([
			...Object.keys(BASE_ESTABLISHED_LANGUAGES_BY_COUNTRY),
			...Object.keys(CURATED_REGIONAL_LANGUAGES_BY_COUNTRY),
			...Object.keys(ECRML_LANGUAGES_BY_COUNTRY),
		])).sort().map(country => [country, Array.from(new Set([
			...(BASE_ESTABLISHED_LANGUAGES_BY_COUNTRY[country] || []),
			...(CURATED_REGIONAL_LANGUAGES_BY_COUNTRY[country] || []),
			...(ECRML_LANGUAGES_BY_COUNTRY[country] || []),
		]))])
	));

	/*
	 * Languages used broadly across the country as an ordinary shared standard.
	 * This is a functional LocaleAccess classification, not a claim about legal
	 * rank, prestige, or language identity. Countries not listed here use the
	 * first established language above. An explicit empty array means that the
	 * country is intentionally represented only by institutionally official
	 * languages whose practical use may be concentrated by community or region.
	 */
	const COUNTRYWIDE_LANGUAGE_OVERRIDES_BY_COUNTRY = Object.freeze({
		AF: ['fa-AF'],
		AS: ['sm', 'en'],
		AW: ['pap'],
		BA: ['bs', 'hr', 'sr'],
		BE: [],
		BI: ['rn'],
		BQ: ['pap'],
		BF: ['mos', 'dyu', 'fr'],
		BW: ['tn', 'en'],
		BY: ['be', 'ru'],
		BZ: ['en', 'es'],
		CA: ['en'],
		CH: [],
		CM: [],
		CY: [],
		DJ: ['so', 'fr'],
		DZ: ['arq', 'ar', 'fr'],
		EG: ['arz', 'ar'],
		ER: ['ti'],
		ES: ['es'],
		FI: ['fi'],
		FJ: ['fj', 'en'],
		FM: ['en'],
		GF: ['fr', 'gcr'],
		GB: ['en'],
		GL: ['kl', 'da'],
		GH: ['ak', 'en'],
		GQ: ['es'],
		GU: ['en', 'ch'],
		GW: [],
		HK: ['zh-Hant', 'yue'],
		IE: ['en'],
		IM: ['en'],
		// Hindi clears the nationwide shared-language threshold (about 55% for
		// L1 + L2 in Census 2011). English remains nationally official, but its
		// speaker reach does not justify the stronger countrywide tier here.
		IN: ['hi'],
		JO: ['apc', 'ar'],
		KM: [],
		KE: ['sw', 'en'],
		KZ: ['kk', 'ru'],
		LK: ['si'],
		LU: ['lb', 'fr', 'de'],
		LR: ['en'],
		LB: ['apc', 'ar', 'fr'],
		LI: ['de', 'gsw'],
		MA: ['ary', 'ar', 'fr'],
		ME: ['cnr', 'sr'],
		XK: ['sq'],
		MO: ['zh-Hant', 'yue'],
		MT: ['mt', 'en'],
		ML: ['bm', 'fr'],
		MU: ['mfe', 'fr', 'en'],
		MW: ['ny', 'en'],
		MY: ['ms'],
		MR: ['ar', 'fr'],
		NA: ['en', 'af'],
		NE: ['ha', 'fr'],
		NG: ['en', 'pcm'],
		NO: ['nb'],
		NR: ['na', 'en'],
		NZ: ['en'],
		PH: ['fil', 'en'],
		PK: ['ur', 'en'],
		PS: ['apc', 'ar'],
		PY: ['gn', 'es'],
		RW: ['rw', 'en'],
		SC: ['crs', 'fr', 'en'],
		SD: ['apd', 'ar'],
		SG: ['en'],
		SL: ['kri', 'en'],
		SR: ['nl', 'srn'],
		SS: [],
		// English is the principal public standard; the local English creole is
		// also a territory-wide vernacular. Dutch remains in the official tier.
		SX: ['en', 'vic'],
		SZ: ['ss', 'en'],
		SY: ['apc', 'ar'],
		TN: ['aeb', 'ar', 'fr'],
		TZ: ['sw'],
		UG: ['en'],
		// The Latin alphabet is the mandated administrative standard, while the
		// Cyrillic spelling remains a nationwide reading/writing convention rather
		// than a second language with a separate official territorial status.
		UZ: ['uz-Latn', 'uz-Cyrl'],
		US: ['en'],
		VU: ['bi', 'fr', 'en'],
		ZA: ['en'],
		ZM: ['en', 'bem'],
		ZW: ['sn', 'en'],
	});

	const COUNTRYWIDE_LANGUAGES_BY_COUNTRY = Object.freeze(Object.fromEntries(
		Object.entries(ESTABLISHED_LANGUAGES_BY_COUNTRY).map(([country, languages]) => {
			const override = Object.prototype.hasOwnProperty.call(COUNTRYWIDE_LANGUAGE_OVERRIDES_BY_COUNTRY, country)
				? COUNTRYWIDE_LANGUAGE_OVERRIDES_BY_COUNTRY[country]
				: languages.slice(0, 1);
			return [country, override.filter(language => languages.includes(language))];
		})
	));

	/*
	 * Exceptions where the broad established-language inventory contains a
	 * socially important language without national or subnational official
	 * status.  Keep those languages in the resident tier instead of implying a
	 * legal status from the availability of translated public services.
	 */
	const OFFICIAL_LANGUAGE_OVERRIDES_BY_COUNTRY = Object.freeze({
		// Chinese is an established Bruneian community language, not an
		// additional official language alongside the two Malay scripts.
		BN: ['ms-Arab'],
		// France recognises one official language nationally; the other entries
		// below are territorial language relationships rather than additional
		// official languages of the Republic.
		FR: [],
		US: [],
	});
	const OFFICIAL_LAND_SUGGESTION_EXCLUSIONS_BY_COUNTRY = Object.freeze({
		// English is already the global fallback for Bhutan. Treating it as an
		// Indian border-language propagation overstates the institutional model.
		BT: Object.freeze({IN: Object.freeze(['en'])}),
	});

	/*
	 * Regional languages do not normally propagate as neighboring-country
	 * suggestions.  Keep only reviewed cross-border continuities whose scale is
	 * itself part of the regional language area rather than a generic adjacency
	 * effect.  Iranian Azerbaijani reaching neighboring Iraq is the current case.
	 */
	const REGIONAL_LAND_SUGGESTION_EXCEPTIONS_BY_COUNTRY = Object.freeze({
		IR: ['az-Arab'],
	});
	const PROTECTED_LAND_SUGGESTION_EXCEPTIONS_BY_COUNTRY = Object.freeze({
		// Russian remains a large cross-border language in Ukraine even though
		// its current institutional classification is represented conservatively.
		UA: ['ru'],
	});

	/*
	 * Institutional status and territorial rootedness are independent axes.
	 * A language may be institutionally recognised and also belong to a concrete
	 * region (German in Alsace-Moselle), institutionally protected without one
	 * territorial core (Yiddish in Sweden), or regionally rooted without a
	 * separate legal rank.  Keep that overlap here, then derive the exclusive UI
	 * tiers below.
	 */
	const INSTITUTIONAL_LANGUAGES_BY_COUNTRY = Object.freeze(Object.fromEntries(
		Object.entries(ESTABLISHED_LANGUAGES_BY_COUNTRY).map(([country, languages]) => {
			const countrywide = new Set(COUNTRYWIDE_LANGUAGES_BY_COUNTRY[country] || []);
			const derived = languages.filter(language => !countrywide.has(language));
			const official = Object.prototype.hasOwnProperty.call(OFFICIAL_LANGUAGE_OVERRIDES_BY_COUNTRY, country)
				? OFFICIAL_LANGUAGE_OVERRIDES_BY_COUNTRY[country]
				: derived;
			return [country, official.filter(language => languages.includes(language))];
		})
	));

	/*
	 * The Charter inventory also contains non-territorial minority languages.
	 * They have a real institutional relationship to the country, but painting
	 * the whole country with the same strength as an ordinary official language
	 * would overstate their reach. National official languages that also appear
	 * in the Charter are explicitly retained in the ordinary official tier.
	 */
	const NATIONWIDE_OFFICIAL_ECRML_LANGUAGES_BY_COUNTRY = Object.freeze({
		CH: ['de', 'fr', 'it', 'rm'],
		FI: ['sv'],
	});
	const CURATED_PROTECTED_LANGUAGES_BY_COUNTRY = Object.freeze({
		// Åland is constitutionally monolingual Swedish. Finnish remains an
		// institutionally relevant minority language, not a second island-wide
		// official language.
		AX: ['fi'],
		// Romani communities are dispersed rather than a Bulgarian territorial
		// language area; keep the relation visible without inventing one.
		BG: ['rom'],
		// Coptic is a non-territorial liturgical and community language rather than
		// a language of one continuously administered Egyptian region.
		EG: ['cop'],
		// Russian is a large, historically established minority language in both
		// Baltic states, but it is not an additional nationwide official language.
		EE: ['ru'],
		LV: ['ru'],
		// Arabic retains nationally recognised special status, without being the
		// state language or having a legal status confined to one Israeli region.
		IL: ['ar'],
		// Manx belongs to the island's institutional and cultural inventory, but
		// English is the ordinary island-wide shared language today.
		IM: ['gv'],
		// Gagauz is territorial; Russian is the non-territorial nationwide minority
		// relationship represented here.
		MD: ['ru'],
		// Mandarin and Tamil belong to established nationwide communities, while
		// Malay alone occupies the national/official role represented above.
		MY: ['zh-Hans', 'ta'],
		// Mauritius recognises several ancestral languages in public institutions,
		// but Bhojpuri and Urdu do not define a single territorial language area.
		MU: ['bho', 'ur'],
		// Russian remains widely used in Uzbekistan without being a state language.
		UZ: ['ru'],
	});

	const PROTECTED_LANGUAGES_BY_COUNTRY = Object.freeze(Object.fromEntries(
		Array.from(new Set([
			...Object.keys(ECRML_LANGUAGES_BY_COUNTRY),
			...Object.keys(CURATED_PROTECTED_LANGUAGES_BY_COUNTRY),
		])).sort().map(country => {
			const languages = Array.from(new Set([
				...(ECRML_LANGUAGES_BY_COUNTRY[country] || []),
				...(CURATED_PROTECTED_LANGUAGES_BY_COUNTRY[country] || []),
			]));
			const countrywide = new Set(COUNTRYWIDE_LANGUAGES_BY_COUNTRY[country] || []);
			const regional = new Set(REGIONAL_LANGUAGES_BY_COUNTRY[country] || []);
			const nationwideOfficial = new Set(
				NATIONWIDE_OFFICIAL_ECRML_LANGUAGES_BY_COUNTRY[country] || []
			);
			return [country, languages.filter(language => !countrywide.has(language)
				&& !regional.has(language)
				&& !nationwideOfficial.has(language))];
		})
	));

	/*
	 * Cards use mutually exclusive tiers.  Territorial scope is the more useful
	 * visible distinction below a country-wide major language, so an
	 * institutional language whose standing is confined to a concrete region is
	 * displayed as regional.  Its institutional attribute remains available in
	 * INSTITUTIONAL_LANGUAGES_BY_COUNTRY.
	 */
	const OFFICIAL_LANGUAGES_BY_COUNTRY = Object.freeze(Object.fromEntries(
		Object.entries(INSTITUTIONAL_LANGUAGES_BY_COUNTRY).map(([country, languages]) => {
			const regional = new Set(REGIONAL_LANGUAGES_BY_COUNTRY[country] || []);
			const protectedLanguages = new Set(PROTECTED_LANGUAGES_BY_COUNTRY[country] || []);
			return [country, languages.filter(language => !regional.has(language)
				&& !protectedLanguages.has(language))];
		})
	));

	/*
	 * Major established resident / immigrant language communities.
	 * Heuristic and intentionally non-exhaustive; this is UI relevance data,
	 * not a census-derived demographic table. European coverage was reviewed
	 * against Eurostat migr_pop3ctb (2024) and national census sources, using
	 * birthplace only as an audit signal rather than an automatic language map.
	 * Resident English entries represent established English-speaking communities,
	 * not places where English is merely a common second or working language.
	 * As a review guide, a community around 0.2% of the resident population can
	 * become a candidate, and each country is normally kept to roughly ten entries;
	 * absolute size, permanence, and UI usefulness can outweigh either guideline.
	 * Countries are omitted unless there is a high-confidence reason to promote
	 * a curated set of languages;
	 * broad country coverage is not a goal for this table.
	 * Array order is stable UI curation, never a population ranking.
	 */
	const RESIDENT_LANGUAGES_BY_COUNTRY = Object.freeze({
	AE: ['hi', 'ur', 'bn', 'ml', 'ta', 'fil'],
	AR: ['ay', 'arn'],
	AT: ['tr', 'bs', 'sr', 'ro', 'ar', 'uk', 'pl'],
	AU: ['zh-Hans', 'ar', 'vi', 'zh-Hant', 'pa'],
	BE: ['ar', 'tr', 'ro', 'it', 'es', 'pl', 'uk', 'pt-PT', 'en'],
	BG: ['ru', 'uk', 'ar'],
	BH: ['hi', 'ur', 'bn', 'ml', 'fil'],
	BN: ['zh-Hans'],
	CA: ['es', 'zh-Hans', 'zh-Hant', 'pa', 'ar', 'hi', 'fil'],
	CH: ['pt-PT', 'sq', 'sr', 'uk', 'es', 'tr', 'hr', 'bs', 'en'],
	CL: ['ay'],
	CY: ['ru', 'uk', 'bg', 'ro', 'en'],
	CZ: ['uk', 'ru', 'vi'],
	DE: ['tr', 'ar', 'pl', 'ru', 'ro', 'uk', 'it', 'es', 'pt-PT', 'bg', 'hr', 'el', 'sq', 'sr', 'bs', 'en'],
	DK: ['sv', 'nb', 'ar', 'tr', 'pl', 'uk', 'ro', 'ur', 'so'],
	EE: ['uk', 'fi'],
	ES: ['ar', 'ro', 'fr', 'uk', 'zh-Hans', 'pt-BR', 'it', 'ru', 'de', 'en'],
	FI: ['et', 'ar', 'uk', 'so', 'fil'],
	FR: ['ar', 'pt-PT', 'it', 'es', 'tr', 'ro', 'pl', 'uk', 'en'],
	GB: ['pl', 'ro', 'uk', 'pa', 'ur', 'bn', 'fr', 'de', 'es', 'pt-PT', 'it', 'ar', 'gu', 'hi', 'zh-Hans'],
	GR: ['pnt', 'sq', 'bg', 'ro', 'ar', 'ru', 'uk'],
	HR: ['bs'],
	HK: ['fil', 'id'],
	HU: ['zh-Hans', 'vi'],
	IE: ['pl', 'ro', 'uk', 'fr', 'de', 'es', 'pt-PT', 'ar'],
	IL: ['ru', 'ro', 'yi'],
	IS: ['pl', 'uk', 'lt', 'ro', 'fil', 'lv', 'es', 'de'],
	IT: ['ro', 'ar', 'zh-Hans', 'uk', 'ru', 'bn', 'ur', 'fil', 'pt-BR', 'en'],
	JP: ['zh-Hans', 'zh-Hant', 'vi', 'ko', 'fil', 'ne', 'id', 'pt-BR', 'my', 'en'],
	KW: ['hi', 'ur', 'bn', 'ml', 'fil'],
	LT: ['ru', 'uk', 'be', 'lv', 'uz-Latn'],
	LU: ['pt-PT', 'it', 'es', 'ro', 'uk', 'pl', 'zh-Hans', 'ru', 'ar', 'en'],
	LV: ['uk', 'be', 'lt', 'et'],
	MT: ['it', 'hi', 'fil', 'sr', 'ar', 'ru', 'uk', 'bg'],
	NL: ['tr', 'ar', 'pl', 'uk', 'id', 'zh-Hans', 'hi', 'bg', 'ro', 'it', 'es', 'pt-PT', 'en'],
	NO: ['da', 'pl', 'ar', 'so', 'uk', 'lt', 'fil', 'th', 'ur', 'ru'],
	NZ: ['zh-Hans', 'zh-Hant', 'hi', 'pa'],
	OM: ['bal', 'hi', 'ur', 'bn', 'ml', 'fil'],
	PL: ['vi'],
	PT: ['uk', 'ro', 'pt-BR', 'en'],
	QA: ['fa', 'hi', 'ur', 'bn', 'ml', 'fil'],
	RU: ['tk', 'uk', 'zh-Hans'],
	SA: ['ur', 'hi', 'bn', 'fil'],
	SD: ['ha'],
	SE: ['da', 'ar', 'so', 'fa', 'pl', 'uk', 'bs', 'hi', 'tr', 'th', 'zh-Hans', 'sr', 'hr'],
	SI: ['bs', 'sq', 'mk', 'uk', 'ru'],
	SK: ['ro', 'vi'],
	TJ: ['tk'],
	TR: ['tk', 'uk', 'hy', 'pnt'],
	TW: ['id', 'vi', 'fil', 'th'],
	US: ['es', 'fr', 'zh-Hans', 'zh-Hant', 'fil', 'vi', 'ar', 'ko', 'ru', 'yi'],
	});

	/*
	 * Undirected land-border graph derived from the same Natural Earth 10m
	 * topology used by the coverage map. Each physical border is stored once as
	 * [countryA, countryB, borderLengthOrder], where the order is
	 * floor(log10(kilometres)); the runtime derives its bidirectional adjacency.
	 * Country values are [populationOrder, areaOrder, gdpPerCapitaBand].
	 * Population (2024) and surface area (2023) use floor(log10(value)); GDP per
	 * capita (2024) uses representative USD bands 1000/3000/10000/30000/100000.
	 * Sources are World Bank SP.POP.TOTL, AG.SRF.TOTL.K2, and NY.GDP.PCAP.CD.
	 * Missing GDP
	 * values use conservative regional bands rather than disabling the term.
	 * Kosovo area and Western Sahara values use stable geographic fallbacks
	 * where the World Bank series has no value. Runtime ordering estimates mutual
	 * influence as (population ratio + approximate total-GDP ratio) multiplied by
	 * the bilateral share of the land border.
	 * Land adjacency affects suggestions only; it is not a language role.
	 */
	const LAND_BORDER_COUNTRIES = Object.freeze({
		AD: [4, 2, 30000],
		AE: [7, 4, 30000],
		AF: [7, 5, 1000],
		AL: [6, 4, 10000],
		AM: [6, 4, 3000],
		AO: [7, 6, 1000],
		AR: [7, 6, 10000],
		AT: [6, 4, 30000],
		AZ: [7, 4, 3000],
		BA: [6, 4, 3000],
		BD: [8, 5, 1000],
		BE: [7, 4, 30000],
		BF: [7, 5, 1000],
		BG: [6, 5, 10000],
		BI: [7, 4, 1000],
		BJ: [7, 5, 1000],
		BN: [5, 3, 30000],
		BO: [7, 6, 3000],
		BR: [8, 6, 10000],
		BT: [5, 4, 3000],
		BW: [6, 5, 3000],
		BY: [6, 5, 3000],
		BZ: [5, 4, 3000],
		CA: [7, 7, 30000],
		CD: [8, 6, 1000],
		CF: [6, 5, 1000],
		CG: [6, 5, 1000],
		CH: [6, 4, 100000],
		CI: [7, 5, 1000],
		CL: [7, 5, 10000],
		CM: [7, 5, 1000],
		CN: [9, 6, 10000],
		CO: [7, 6, 3000],
		CR: [6, 4, 10000],
		CZ: [7, 4, 30000],
		DE: [7, 5, 30000],
		DJ: [6, 4, 3000],
		DK: [6, 4, 30000],
		DO: [7, 5, 10000],
		DZ: [7, 6, 3000],
		EC: [7, 5, 3000],
		EE: [6, 4, 30000],
		EG: [8, 6, 3000],
		EH: [5, 5, 1000],
		ER: [6, 5, 1000],
		ES: [7, 5, 30000],
		ET: [8, 6, 1000],
		FI: [6, 5, 30000],
		FR: [7, 5, 30000],
		GA: [6, 5, 3000],
		GB: [7, 5, 30000],
		GE: [6, 4, 3000],
		GF: [5, 4, 10000],
		GH: [7, 5, 1000],
		GI: [4, 1, 30000],
		GM: [6, 4, 1000],
		GN: [7, 5, 1000],
		GQ: [6, 4, 3000],
		GR: [7, 5, 10000],
		GT: [7, 5, 3000],
		GW: [6, 4, 1000],
		GY: [5, 5, 10000],
		HK: [6, 3, 30000],
		HN: [7, 5, 3000],
		HR: [6, 4, 10000],
		HT: [7, 4, 1000],
		HU: [6, 4, 10000],
		ID: [8, 6, 3000],
		IE: [6, 4, 100000],
		IL: [7, 4, 30000],
		IN: [9, 6, 1000],
		IQ: [7, 5, 3000],
		IR: [7, 6, 3000],
		IT: [7, 5, 30000],
		JO: [7, 4, 3000],
		KE: [7, 5, 1000],
		KG: [6, 5, 1000],
		KH: [7, 5, 1000],
		KP: [7, 5, 1000],
		KR: [7, 5, 30000],
		KW: [6, 4, 30000],
		KZ: [7, 6, 10000],
		LA: [6, 5, 1000],
		LB: [6, 4, 3000],
		LI: [4, 2, 100000],
		LR: [6, 5, 1000],
		LS: [6, 4, 1000],
		LT: [6, 4, 10000],
		LU: [5, 3, 100000],
		LV: [6, 4, 10000],
		LY: [6, 6, 3000],
		MA: [7, 5, 3000],
		MC: [4, 1, 100000],
		MD: [6, 4, 3000],
		ME: [5, 4, 10000],
		MF: [4, 1, 10000],
		MK: [6, 4, 3000],
		ML: [7, 6, 1000],
		MM: [7, 5, 1000],
		MN: [6, 6, 3000],
		MR: [6, 6, 1000],
		MW: [7, 5, 1000],
		MX: [8, 6, 10000],
		MY: [7, 5, 10000],
		MZ: [7, 5, 1000],
		NA: [6, 5, 3000],
		NE: [7, 6, 1000],
		NG: [8, 5, 1000],
		NI: [6, 5, 1000],
		NL: [7, 4, 30000],
		NO: [6, 5, 30000],
		NP: [7, 5, 1000],
		OM: [6, 5, 10000],
		PA: [6, 4, 10000],
		PE: [7, 6, 3000],
		PG: [7, 5, 1000],
		PK: [8, 5, 1000],
		PL: [7, 5, 10000],
		PS: [6, 3, 3000],
		PT: [7, 4, 10000],
		PY: [6, 5, 3000],
		QA: [6, 4, 30000],
		RO: [7, 5, 10000],
		RS: [6, 4, 10000],
		RU: [8, 7, 10000],
		RW: [7, 4, 1000],
		SA: [7, 6, 30000],
		SD: [7, 6, 1000],
		SE: [7, 5, 30000],
		SI: [6, 4, 30000],
		SK: [6, 4, 10000],
		SL: [6, 4, 1000],
		SM: [4, 1, 30000],
		SN: [7, 5, 1000],
		SO: [7, 5, 1000],
		SR: [5, 5, 3000],
		SS: [7, 5, 1000],
		SV: [6, 4, 3000],
		SX: [4, 1, 30000],
		SY: [7, 5, 1000],
		SZ: [6, 4, 3000],
		TD: [7, 6, 1000],
		TG: [6, 4, 1000],
		TH: [7, 5, 3000],
		TJ: [7, 5, 1000],
		TL: [6, 4, 1000],
		TM: [6, 5, 3000],
		TN: [7, 5, 3000],
		TR: [7, 5, 10000],
		TZ: [7, 5, 1000],
		UA: [7, 5, 3000],
		UG: [7, 5, 1000],
		US: [8, 6, 30000],
		UY: [6, 5, 10000],
		UZ: [7, 5, 3000],
		VE: [7, 5, 3000],
		VN: [8, 5, 3000],
		XK: [6, 4, 3000],
		YE: [7, 5, 1000],
		ZA: [7, 6, 3000],
		ZM: [7, 5, 1000],
		ZW: [7, 5, 1000],
	});
	const LAND_BORDERS = Object.freeze([
		['AD', 'ES', 1],
		['AD', 'FR', 1],
		['AE', 'OM', 2],
		['AE', 'SA', 2],
		['AF', 'CN', 1],
		['AF', 'IR', 2],
		['AF', 'PK', 3],
		['AF', 'TJ', 3],
		['AF', 'TM', 2],
		['AF', 'UZ', 2],
		['AL', 'GR', 2],
		['AL', 'ME', 2],
		['AL', 'MK', 2],
		['AL', 'XK', 1],
		['AM', 'AZ', 2],
		['AM', 'GE', 2],
		['AM', 'IR', 1],
		['AM', 'TR', 2],
		['AO', 'CD', 3],
		['AO', 'CG', 2],
		['AO', 'NA', 3],
		['AO', 'ZM', 3],
		['AR', 'BO', 2],
		['AR', 'BR', 2],
		['AR', 'CL', 3],
		['AR', 'PY', 3],
		['AR', 'UY', 2],
		['AT', 'CH', 2],
		['AT', 'CZ', 2],
		['AT', 'DE', 2],
		['AT', 'HU', 2],
		['AT', 'IT', 2],
		['AT', 'LI', 1],
		['AT', 'SI', 2],
		['AT', 'SK', 1],
		['AZ', 'GE', 2],
		['AZ', 'IR', 2],
		['AZ', 'RU', 2],
		['AZ', 'TR', 0],
		['BA', 'HR', 2],
		['BA', 'ME', 2],
		['BA', 'RS', 2],
		['BD', 'IN', 3],
		['BD', 'MM', 2],
		['BE', 'DE', 2],
		['BE', 'FR', 2],
		['BE', 'LU', 2],
		['BE', 'NL', 2],
		['BF', 'BJ', 2],
		['BF', 'CI', 2],
		['BF', 'GH', 2],
		['BF', 'ML', 3],
		['BF', 'NE', 2],
		['BF', 'TG', 2],
		['BG', 'GR', 2],
		['BG', 'MK', 2],
		['BG', 'RO', 2],
		['BG', 'RS', 2],
		['BG', 'TR', 2],
		['BI', 'CD', 2],
		['BI', 'RW', 2],
		['BI', 'TZ', 2],
		['BJ', 'NE', 2],
		['BJ', 'NG', 2],
		['BJ', 'TG', 2],
		['BN', 'MY', 2],
		['BO', 'BR', 3],
		['BO', 'CL', 2],
		['BO', 'PE', 2],
		['BO', 'PY', 2],
		['BR', 'CO', 3],
		['BR', 'GF', 2],
		['BR', 'GY', 3],
		['BR', 'PE', 3],
		['BR', 'PY', 3],
		['BR', 'SR', 2],
		['BR', 'UY', 2],
		['BR', 'VE', 3],
		['BT', 'CN', 2],
		['BT', 'IN', 2],
		['BW', 'NA', 3],
		['BW', 'ZA', 3],
		['BW', 'ZW', 2],
		['BY', 'LT', 2],
		['BY', 'LV', 2],
		['BY', 'PL', 2],
		['BY', 'RU', 2],
		['BY', 'UA', 2],
		['BZ', 'GT', 2],
		['BZ', 'MX', 2],
		['CA', 'US', 3],
		['CD', 'CF', 3],
		['CD', 'CG', 3],
		['CD', 'RW', 2],
		['CD', 'SS', 2],
		['CD', 'TZ', 2],
		['CD', 'UG', 2],
		['CD', 'ZM', 3],
		['CF', 'CG', 2],
		['CF', 'CM', 2],
		['CF', 'SD', 2],
		['CF', 'SS', 2],
		['CF', 'TD', 3],
		['CG', 'CM', 2],
		['CG', 'GA', 3],
		['CH', 'DE', 2],
		['CH', 'FR', 2],
		['CH', 'IT', 2],
		['CH', 'LI', 1],
		['CI', 'GH', 2],
		['CI', 'GN', 2],
		['CI', 'LR', 2],
		['CI', 'ML', 2],
		['CL', 'PE', 2],
		['CM', 'GA', 2],
		['CM', 'GQ', 2],
		['CM', 'NG', 3],
		['CM', 'TD', 3],
		['CN', 'HK', 1],
		['CN', 'IN', 3],
		['CN', 'KG', 2],
		['CN', 'KP', 3],
		['CN', 'KZ', 3],
		['CN', 'LA', 2],
		['CN', 'MM', 3],
		['CN', 'MN', 3],
		['CN', 'NP', 3],
		['CN', 'PK', 2],
		['CN', 'RU', 3],
		['CN', 'TJ', 2],
		['CN', 'VN', 3],
		['CO', 'EC', 2],
		['CO', 'PA', 2],
		['CO', 'PE', 3],
		['CO', 'VE', 3],
		['CR', 'NI', 2],
		['CR', 'PA', 2],
		['CZ', 'DE', 2],
		['CZ', 'PL', 2],
		['CZ', 'SK', 2],
		['DE', 'DK', 1],
		['DE', 'FR', 2],
		['DE', 'LU', 2],
		['DE', 'NL', 2],
		['DE', 'PL', 2],
		['DJ', 'ER', 2],
		['DJ', 'ET', 2],
		['DJ', 'SO', 1],
		['DO', 'HT', 2],
		['DZ', 'EH', 1],
		['DZ', 'LY', 2],
		['DZ', 'MA', 3],
		['DZ', 'ML', 3],
		['DZ', 'MR', 2],
		['DZ', 'NE', 2],
		['DZ', 'TN', 2],
		['EC', 'PE', 3],
		['EE', 'LV', 2],
		['EE', 'RU', 2],
		['EG', 'IL', 2],
		['EG', 'LY', 3],
		['EG', 'PS', 1],
		['EG', 'SD', 3],
		['EH', 'MA', 3],
		['EH', 'MR', 3],
		['ER', 'ET', 2],
		['ER', 'SD', 2],
		['ES', 'FR', 2],
		['ES', 'GI', 0],
		['ES', 'MA', 1],
		['ES', 'PT', 3],
		['ET', 'KE', 2],
		['ET', 'SD', 2],
		['ET', 'SO', 3],
		['ET', 'SS', 2],
		['FI', 'NO', 2],
		['FI', 'RU', 3],
		['FI', 'SE', 2],
		['FR', 'IT', 2],
		['FR', 'LU', 1],
		['FR', 'MC', 0],
		['GF', 'SR', 2],
		['GA', 'GQ', 2],
		['GB', 'IE', 2],
		['GE', 'RU', 2],
		['GE', 'TR', 2],
		['GH', 'TG', 2],
		['GM', 'SN', 2],
		['GN', 'GW', 2],
		['GN', 'LR', 2],
		['GN', 'ML', 2],
		['GN', 'SL', 2],
		['GN', 'SN', 2],
		['GR', 'MK', 2],
		['GR', 'TR', 2],
		['GT', 'HN', 2],
		['GT', 'MX', 2],
		['GT', 'SV', 2],
		['GW', 'SN', 2],
		['GY', 'SR', 2],
		['GY', 'VE', 2],
		['HN', 'NI', 2],
		['HN', 'SV', 2],
		['HR', 'HU', 2],
		['HR', 'ME', 1],
		['HR', 'RS', 2],
		['HR', 'SI', 2],
		['HU', 'RO', 2],
		['HU', 'RS', 2],
		['HU', 'SI', 1],
		['HU', 'SK', 2],
		['HU', 'UA', 1],
		['ID', 'MY', 3],
		['ID', 'PG', 2],
		['ID', 'TL', 2],
		['IL', 'JO', 2],
		['IL', 'LB', 1],
		['IL', 'PS', 2],
		['IL', 'SY', 1],
		['IN', 'MM', 3],
		['IN', 'NP', 3],
		['IN', 'PK', 3],
		['IQ', 'IR', 3],
		['IQ', 'JO', 2],
		['IQ', 'KW', 2],
		['IQ', 'SA', 2],
		['IQ', 'SY', 2],
		['IQ', 'TR', 2],
		['IR', 'PK', 2],
		['IR', 'TM', 2],
		['IR', 'TR', 2],
		['IT', 'SI', 2],
		['IT', 'SM', 1],
		['JO', 'PS', 2],
		['JO', 'SA', 2],
		['JO', 'SY', 2],
		['KE', 'SO', 2],
		['KE', 'SS', 2],
		['KE', 'TZ', 2],
		['KE', 'UG', 2],
		['KG', 'KZ', 3],
		['KG', 'TJ', 2],
		['KG', 'UZ', 3],
		['KH', 'LA', 2],
		['KH', 'TH', 2],
		['KH', 'VN', 2],
		['KP', 'KR', 2],
		['KP', 'RU', 1],
		['KW', 'SA', 2],
		['KZ', 'RU', 3],
		['KZ', 'TM', 2],
		['KZ', 'UZ', 3],
		['LA', 'MM', 2],
		['LA', 'TH', 3],
		['LA', 'VN', 3],
		['LB', 'SY', 2],
		['LR', 'SL', 2],
		['LS', 'ZA', 2],
		['LT', 'LV', 2],
		['LT', 'PL', 1],
		['LT', 'RU', 2],
		['LV', 'RU', 2],
		['LY', 'NE', 2],
		['LY', 'SD', 2],
		['LY', 'TD', 3],
		['LY', 'TN', 2],
		['MD', 'RO', 2],
		['MD', 'UA', 2],
		['ME', 'RS', 2],
		['ME', 'XK', 1],
		['MF', 'SX', 1],
		['MK', 'RS', 1],
		['MK', 'XK', 2],
		['ML', 'MR', 3],
		['ML', 'NE', 2],
		['ML', 'SN', 2],
		['MM', 'TH', 3],
		['MN', 'RU', 3],
		['MR', 'SN', 2],
		['MW', 'MZ', 3],
		['MW', 'TZ', 2],
		['MW', 'ZM', 2],
		['MX', 'US', 3],
		['MY', 'TH', 2],
		['MZ', 'SZ', 2],
		['MZ', 'TZ', 2],
		['MZ', 'ZA', 2],
		['MZ', 'ZM', 2],
		['MZ', 'ZW', 3],
		['NA', 'ZA', 2],
		['NA', 'ZM', 2],
		['NE', 'NG', 3],
		['NE', 'TD', 3],
		['NG', 'TD', 1],
		['NO', 'RU', 2],
		['NO', 'SE', 3],
		['OM', 'SA', 2],
		['OM', 'YE', 2],
		['PL', 'RU', 2],
		['PL', 'SK', 2],
		['PL', 'UA', 2],
		['QA', 'SA', 1],
		['RO', 'RS', 2],
		['RO', 'UA', 2],
		['RS', 'XK', 2],
		['RU', 'UA', 3],
		['RW', 'TZ', 2],
		['RW', 'UG', 2],
		['SA', 'YE', 3],
		['SD', 'SS', 3],
		['SD', 'TD', 3],
		['SK', 'UA', 1],
		['SS', 'UG', 2],
		['SY', 'TR', 2],
		['SZ', 'ZA', 2],
		['TJ', 'UZ', 3],
		['TM', 'UZ', 3],
		['TZ', 'UG', 2],
		['TZ', 'ZM', 2],
		['ZA', 'ZW', 2],
		['ZM', 'ZW', 2],
	]);

	const buildLandBorderGraph = () => {
		const graph = Object.fromEntries(
			Object.entries(LAND_BORDER_COUNTRIES).map(([
				country,
				[populationOrder, areaOrder, gdpPerCapitaBand],
			]) => [
				country,
				{populationOrder, areaOrder, gdpPerCapitaBand, neighbors: []},
			])
		);
		for (const [left, right, borderLengthOrder] of LAND_BORDERS) {
			graph[left].neighbors.push([right, borderLengthOrder]);
			graph[right].neighbors.push([left, borderLengthOrder]);
		}
		return Object.freeze(Object.fromEntries(
			Object.entries(graph).map(([country, node]) => [country, Object.freeze({
				...node,
				neighbors: Object.freeze(node.neighbors.map(entry => Object.freeze(entry))),
			})])
		));
	};
	const LAND_BORDER_GRAPH = buildLandBorderGraph();

	/*
	 * The graph records physical adjacency; mobility is a separate edge weight.
	 * Ordinary borders default to 1, structurally open Schengen borders use 5,
	 * and only exceptional controlled or closed borders need sparse overrides.
	 */
	const OPEN_LAND_BORDER_COUNTRIES = new Set([
		'AT', 'BE', 'BG', 'CH', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR',
		'HR', 'HU', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL',
		'PT', 'RO', 'SE', 'SI', 'SK',
	]);
	const DEFAULT_LAND_BORDER_PERMEABILITY = 1;
	const OPEN_LAND_BORDER_PERMEABILITY = 5;
	const LAND_BORDER_PERMEABILITY = Object.freeze({
		'AM-AZ': 0.01,
		'AM-TR': 0.01,
		'BT-CN': 0.1,
		'EG-IL': 0.1,
		'IL-JO': 0.1,
		'IL-LB': 0.01,
		'IL-SY': 0.01,
	});

	/*
	 * Site-independent languages with broad relevance across country contexts.
	 * Keep this separate from territorial, mobility, and resident-community data
	 * so the globally useful slot is explicit rather than hard-coded in sorting.
	 * The ordered list may contain zero, one, or multiple language codes.
	 */
	const GLOBAL_LANGUAGES = Object.freeze(['en']);
	const LANGUAGE_SPEAKER_ORDERS = Object.freeze(__LANGUAGE_SPEAKER_ORDERS__);
	const LAND_NEIGHBOR_INFLUENCE_CUTOFF = 0.01;
	const OFFICIAL_NEIGHBOR_INFLUENCE_FACTOR = 0.05;

	const pendingContexts = new Map();
	const resolvedContexts = new Map();

	const normalizeCountryCode = value => {
		const country = String(value || '').trim().toUpperCase();
		return /^[A-Z]{2}$/.test(country) && country !== 'XX' && country !== 'T1'
			? country
			: '';
	};

	const parseAcceptLanguage = value => String(value || '').split(',')
		.map((entry, index) => {
			const parts = entry.trim().split(';');
			const language = String(parts.shift() || '').trim().replaceAll('_', '-');
			if (!language || language === '*' || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(language)) {
				return null;
			}
			let quality = 1;
			for (const parameter of parts) {
				const match = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/i.exec(parameter);
				if (match) quality = Number(match[1]);
			}
			return quality > 0 ? {language, quality, index} : null;
		})
		.filter(Boolean)
		.sort((left, right) => right.quality - left.quality || left.index - right.index)
		.filter((entry, index, entries) => entries.findIndex(candidate =>
			candidate.language.toLowerCase() === entry.language.toLowerCase()) === index)
		.map(entry => entry.language);

	const browserLanguages = () => {
		if (typeof navigator === 'undefined') return [];
		const languages = navigator.languages && navigator.languages.length
			? navigator.languages
			: [navigator.language];
		return [...languages].filter(Boolean);
	};

	const resolveCountryEndpoint = options => {
		if (options && options.endpoint) return options.endpoint;
		if (typeof document !== 'undefined') {
			const meta = document.querySelector('meta[name="atlas-locale-context"]');
			const fromMeta = meta && String(meta.getAttribute('content') || '').trim();
			if (fromMeta) return fromMeta;
			const fromDataset = String(
				document.documentElement.getAttribute('data-atlas-locale-context') || ''
			).trim();
			if (fromDataset) return fromDataset;
		}
		return COUNTRY_ENDPOINT;
	};

	const landBorderPermeability = (country, neighbor) => {
		const override = LAND_BORDER_PERMEABILITY[[country, neighbor].sort().join('-')];
		if (Number.isFinite(override)) return override;
		return OPEN_LAND_BORDER_COUNTRIES.has(country)
			&& OPEN_LAND_BORDER_COUNTRIES.has(neighbor)
			? OPEN_LAND_BORDER_PERMEABILITY
			: DEFAULT_LAND_BORDER_PERMEABILITY;
	};

	const defaultStorage = () => {
		try { return window.localStorage; } catch { return null; }
	};

	const readCachedCountry = (storage, key) => {
		if (!storage) return '';
		try {
			const cached = JSON.parse(storage.getItem(key));
			return cached?.expires > Date.now() ? normalizeCountryCode(cached.country) : '';
		} catch {
			return '';
		}
	};

	const writeCachedCountry = (storage, key, country, ttl) => {
		if (!storage) return;
		try {
			storage.setItem(key, JSON.stringify({
				country,
				expires: Date.now() + ttl,
			}));
		} catch {}
	};

	/* One endpoint read supplies both the HTTP language preferences and country. */
	const fetchAccessContext = async (options = {}) => {
		const endpoint = resolveCountryEndpoint(options);
		if (resolvedContexts.has(endpoint)) return resolvedContexts.get(endpoint);
		if (pendingContexts.has(endpoint)) return pendingContexts.get(endpoint);

		const pending = (async () => {
			try {
				const response = await fetch(endpoint, {
					headers: {Accept: 'application/json'},
					cache: 'no-store',
				});
				if (!response.ok) throw new Error('locale context unavailable');

				const payload = await response.json();
				return {
					country: normalizeCountryCode(payload && payload.country),
					accepted: parseAcceptLanguage(payload && payload.acceptLanguage),
				};
			} catch {
				return {country: '', accepted: []};
			} finally {
				pendingContexts.delete(endpoint);
			}
		})();

		pendingContexts.set(endpoint, pending);
		const context = await pending;
		resolvedContexts.set(endpoint, context);
		return context;
	};

	/*
	 * Idempotent country lookup:
	 * - valid storage value -> return it without network access
	 * - cache miss/expiry -> reuse the shared context request, then store it
	 */
	const getCountryCode = async (options = {}) => {
		const cacheKey = options.cacheKey || COUNTRY_CACHE_KEY;
		const ttl = options.ttl ?? COUNTRY_CACHE_TTL;
		const storage = options.storage === undefined ? defaultStorage() : options.storage;
		const cached = readCachedCountry(storage, cacheKey);
		if (cached) return cached;

		const context = await fetchAccessContext(options);
		if (context.country) writeCachedCountry(storage, cacheKey, context.country, ttl);
		return context.country;
	};

	/*
	 * Country code -> site-independent BCP 47 candidate list. Land neighbors
	 * supply suggestions without becoming a territorial language role.
	 * First occurrence wins across the ordered tiers.
	 */
	const landNeighborInfluence = (country, [neighbor, borderLengthOrder]) => {
		const own = LAND_BORDER_GRAPH[country];
		const other = LAND_BORDER_GRAPH[neighbor];
		if (!own || !other) return 0;
		const totalBorderWeight = own.neighbors.reduce(
			(sum, entry) => sum + (10 ** entry[1]),
			0
		);
		if (!totalBorderWeight) return 0;
		const populationRatio = Math.min(
			1,
			10 ** (other.populationOrder - own.populationOrder)
		);
		const economicMassRatio = Number.isFinite(other.gdpPerCapitaBand)
			&& Number.isFinite(own.gdpPerCapitaBand)
			? Math.min(1, populationRatio * (other.gdpPerCapitaBand / own.gdpPerCapitaBand))
			: 0;
		const borderShare = (10 ** borderLengthOrder) / totalBorderWeight;
		return (economicMassRatio + populationRatio)
			* borderShare
			* landBorderPermeability(country, neighbor);
	};

	const getCountryLandNeighborEntries = countryCode => {
		const country = normalizeCountryCode(countryCode);
		const own = LAND_BORDER_GRAPH[country];
		if (!own) return [];
		return own.neighbors.slice().sort((left, right) =>
			landNeighborInfluence(country, right) - landNeighborInfluence(country, left)
				|| left[0].localeCompare(right[0])
		);
	};

	const getCountryLandNeighbors = countryCode =>
		getCountryLandNeighborEntries(countryCode)
			.filter(entry => landNeighborInfluence(normalizeCountryCode(countryCode), entry)
				>= LAND_NEIGHBOR_INFLUENCE_CUTOFF)
			.map(([neighbor]) => neighbor);

	/*
	 * Institutional status does not imply country-wide everyday reach. Preserve
	 * that tier for strongly asymmetric border relationships, but discount it
	 * before applying the same cutoff used by country-wide suggestions.
	 */
	const officialLanguagePopulationShare = (country, language) => {
		const countryOrder = LAND_BORDER_GRAPH[country]?.populationOrder;
		const languageOrder = LANGUAGE_SPEAKER_ORDERS[language]
			?? LANGUAGE_SPEAKER_ORDERS[language.split('-', 1)[0]];
		if (!Number.isFinite(countryOrder) || !Number.isFinite(languageOrder)) return 0;
		return Math.min(1, 10 ** (languageOrder - countryOrder));
	};

	const getCountryOfficialLandSuggestions = countryCode => {
		const country = normalizeCountryCode(countryCode);
		return getCountryLandNeighborEntries(country).map(entry => {
			const neighbor = entry[0];
			const languageExclusions = new Set(
				OFFICIAL_LAND_SUGGESTION_EXCLUSIONS_BY_COUNTRY[country]?.[neighbor] || []
			);
			const baseEstablished = BASE_ESTABLISHED_LANGUAGES_BY_COUNTRY[neighbor] || [];
			const countrywide = new Set(COUNTRYWIDE_LANGUAGES_BY_COUNTRY[neighbor] || []);
			const regional = new Set(REGIONAL_LANGUAGES_BY_COUNTRY[neighbor] || []);
			const protectedLanguages = new Set(PROTECTED_LANGUAGES_BY_COUNTRY[neighbor] || []);
			const protectedExceptions = new Set(
				PROTECTED_LAND_SUGGESTION_EXCEPTIONS_BY_COUNTRY[neighbor] || []
			);
			const regionalExceptions = new Set(
				REGIONAL_LAND_SUGGESTION_EXCEPTIONS_BY_COUNTRY[neighbor] || []
			);
			const baseOfficial = Object.prototype.hasOwnProperty.call(
				OFFICIAL_LANGUAGE_OVERRIDES_BY_COUNTRY,
				neighbor
			)
				? OFFICIAL_LANGUAGE_OVERRIDES_BY_COUNTRY[neighbor]
				: baseEstablished.filter(language => !countrywide.has(language)
					&& (!protectedLanguages.has(language) || protectedExceptions.has(language))
					&& (!regional.has(language) || regionalExceptions.has(language)));
			const languages = baseOfficial
				.filter(language => !languageExclusions.has(language))
				.filter(language => Math.min(1, landNeighborInfluence(country, entry))
					* OFFICIAL_NEIGHBOR_INFLUENCE_FACTOR
					* officialLanguagePopulationShare(neighbor, language)
					>= LAND_NEIGHBOR_INFLUENCE_CUTOFF);
			return [neighbor, languages];
		}).filter(([, languages]) => languages.length);
	};

	const neighborLanguages = (neighbors, table) => neighbors
		.flatMap(neighbor => table[neighbor] || []);

	/*
	 * Rare country-level tie-breakers where the generic role order obscures the
	 * practical fallback path. Bhutan is linked much more strongly to India;
	 * keep Hindi and India's official English fallback ahead of Chinese while
	 * retaining each language's underlying relation role.
	 */
	const LANGUAGE_SUGGESTION_ORDER_OVERRIDES_BY_COUNTRY = Object.freeze({
		BT: ['dz', 'tsj', 'hi', 'en', 'zh-Hans'],
		US: ['en', 'es', 'fr', 'haw'],
	});

	const getCountryLanguageCodes = countryCode => {
		const country = normalizeCountryCode(countryCode);
		if (!country) return [];

		const suggestions = [...new Set([
			...(COUNTRYWIDE_LANGUAGES_BY_COUNTRY[country] || []),
			...(OFFICIAL_LANGUAGES_BY_COUNTRY[country] || []),
			...(REGIONAL_LANGUAGES_BY_COUNTRY[country] || []),
			...(PROTECTED_LANGUAGES_BY_COUNTRY[country] || []),
			...neighborLanguages(getCountryLandNeighbors(country), COUNTRYWIDE_LANGUAGES_BY_COUNTRY),
			...(RESIDENT_LANGUAGES_BY_COUNTRY[country] || []),
			...getCountryOfficialLandSuggestions(country).flatMap(([, languages]) => languages),
			...GLOBAL_LANGUAGES,
		])];
		const preferredOrder = LANGUAGE_SUGGESTION_ORDER_OVERRIDES_BY_COUNTRY[country] || [];
		if (!preferredOrder.length) return suggestions;
		const preferredSet = new Set(preferredOrder);
		return preferredOrder.filter(language => suggestions.includes(language))
			.concat(suggestions.filter(language => !preferredSet.has(language)));
	};

	/*
	 * Resolve the complete access order with one call. HTTP Accept-Language comes
	 * first, followed by country-based suggestions. The browser list is only a
	 * fallback for static/local hosts where the endpoint is unavailable.
	 */
	const getAccessLanguageContext = async (options = {}) => {
		const remote = await fetchAccessContext(options);
		const accepted = remote.accepted.length ? remote.accepted : browserLanguages();
		const country = remote.country || await getCountryCode(options);
		const suggested = getCountryLanguageCodes(country);
		return Object.freeze({
			country,
			accepted: Object.freeze([...accepted]),
			suggested: Object.freeze([...suggested]),
			languages: Object.freeze([...new Set([...accepted, ...suggested])]),
		});
	};

	const getAccessLanguageSuggestions = async options =>
		(await getAccessLanguageContext(options)).languages;

	/*
	 * Read-only snapshot for internal coverage/reporting surfaces. Runtime
	 * suggestion logic remains country-first; reports reverse these exact tables
	 * so their explanation cannot drift from what the selector actually uses.
	 */
	const getCoverageData = () => {
		const copyTable = table => Object.fromEntries(
			Object.entries(table).map(([country, languages]) => [country, [...languages]])
		);
		const copyLandBorderGraph = () => Object.fromEntries(
			Object.entries(LAND_BORDER_GRAPH).map(([country, node]) => [country, {
				neighbors: getCountryLandNeighborEntries(country).map(entry => [...entry]),
				populationOrder: node.populationOrder,
				areaOrder: node.areaOrder,
				gdpPerCapitaBand: node.gdpPerCapitaBand,
			}])
		);
		return {
			countrywide: copyTable(COUNTRYWIDE_LANGUAGES_BY_COUNTRY),
			institutional: copyTable(INSTITUTIONAL_LANGUAGES_BY_COUNTRY),
			official: copyTable(OFFICIAL_LANGUAGES_BY_COUNTRY),
			regional: copyTable(REGIONAL_LANGUAGES_BY_COUNTRY),
			protected: copyTable(PROTECTED_LANGUAGES_BY_COUNTRY),
			resident: copyTable(RESIDENT_LANGUAGES_BY_COUNTRY),
			institutionalSources: {
				ecrml: copyTable(ECRML_LANGUAGES_BY_COUNTRY),
				curatedProtected: copyTable(CURATED_PROTECTED_LANGUAGES_BY_COUNTRY),
			},
			curatedRegional: copyTable(CURATED_REGIONAL_LANGUAGES_BY_COUNTRY),
			landBorderGraph: copyLandBorderGraph(),
			landBorderMobility: {
				default: DEFAULT_LAND_BORDER_PERMEABILITY,
				open: OPEN_LAND_BORDER_PERMEABILITY,
				openCountries: [...OPEN_LAND_BORDER_COUNTRIES],
				overrides: {...LAND_BORDER_PERMEABILITY},
			},
			landBorderSuggestions: Object.fromEntries(
				Object.keys(LAND_BORDER_GRAPH).map(country =>
					[country, getCountryLandNeighbors(country)])
			),
			landBorderOfficialSuggestions: Object.fromEntries(
				Object.keys(LAND_BORDER_GRAPH).map(country => [
					country,
					Object.fromEntries(getCountryOfficialLandSuggestions(country)
						.map(([neighbor, languages]) => [neighbor, [...languages]])),
				])
			),
			global: [...GLOBAL_LANGUAGES],
		};
	};

	return Object.freeze({
		parseAcceptLanguage,
		getAccessLanguageContext,
		getCountryCode,
		getCountryLandNeighbors,
		getCountryLanguageCodes,
		getAccessLanguageSuggestions,
		getCoverageData,
	});
})();

if (typeof window !== 'undefined') window.LocaleAccess = LocaleAccess;
