/**
 * The geometry behind the Smart Load Planner's 3D map — pure, and tested without a DOM.
 *
 * No map library and no tile server. The state outline is the union of Andhra
 * Pradesh's 26 districts (the April 2022 reorganisation), simplified to ~220 m —
 * 2,635 vertices where the first cut had 190 — and cross-checked against the
 * geoBoundaries ADM1 polygon: the two agree to within 0.4% of the state's area, and
 * 810 of the 811 live stocking points fall inside it (the other sits on the Telangana
 * line itself). Yanam, Puducherry's enclave on the Godavari delta, is a hole in it.
 * Everything else the map draws — districts, relief, rivers — is in `apMapData.ts`,
 * loaded lazily; this file stays small because `insideAp` runs on any screen.
 *
 * World space is kilometres on a flat plane centred on the state: x east, y north,
 * z up. The camera orbits it (yaw), tilts it (pitch: 0 = straight down), zooms and
 * pans, with a mild perspective so the far side of the state recedes.
 */

/** Google encoded polyline (1e-4 degree) of the outline, closed. */
const OUTLINE_ENCODED = "shzFgsxn@yDj@x@_J_FuBw@^|A`E_@hBgHq@oA{@x@u@KcDmBwBoATgCyBwD@m@qBgC~@_A}AjOqMbCaEUgCyDaAzGaHj@aHuAqCiCUAmD~LqAvF}GtF_@eIkAqMf@eN|Q{@rDzDvB@x@wLlCcB_EiEl@dAaD{ByEsAzAoFDaAy@vCgSeDAiCmBcHvBi@hAeNv@mF_@KiEeAqAiCUCoDwCcEq@{J}I~BwESwAaCJwBwBa@kBeGsGpJeEh@[{C_EoB?_HaC_AiCjCmDqET}GcA{@YyD_Lx@_BzCt@|HwCVm@MUwHwE_Bc@qCoBb@]nEmCBmHaBq@^qEgF_FgBaGIm@lDaHf@iHhEn@n@fGKlCtAzAbCuAnDVfB`I|A`ApAaChEiDb@a@jBsBHIjDmDlBs@jKkGcA}Bn@LvD`BlA`D~L{KbBe@rGbEbDzArIwG`Gk@vEqEkBVeBrBv@R}@c@kJ{As@uBf@gAhGcBB}ClHjBxD_@fAeJyBwBoCqFw@_YrBcCw@mBzAaGK}BhA_H{CiOdAeDiDgDVsHaFoF?aMoFsApA_DCuAzJlBxSyAbAqAvKpCtb@`BzDcHzHa@~BzFjBoBjHbGfBpE|DlAdDgEzAaGIqIeGaNUyA`UuL@{AtSb@pK|BpF~ChACpFaIi@wCbFcCRe@bEeFoDgAlAoCItCoM[kKqNaC_KpHkB~FqHoCgDmHwHiCgBwBmF`BiEnD_MsEcH`@kCbC{DEq@tMt@rDuK|BuGtPfLUjGzB{@vNgCdC_@zEdB|DvVtHt@xMgDeA{^nCmB{D{A}NqAo@yOvB}OkCmBhKzBhB~HdAv@jFvQ`L}@nFgF~IoBToBaAaEv@pAxKTxUkDnFjE|ExJp@bCkAhBRnCcIlHgAjCdDvAyDnDlKfFhBN~KvAhD~Dg@lA{AvCB`B`D^vIzBzGg@hDxAtDlB^l@vEhDm@bIl@pBkAjAdBpLh@TfD_PvBOhCrDnMqJaD_Cb@`@dPpB`ClEfNpB`AfCShCyMbCRvCbH}InGXlGxI`G}ApHxHfEyJrF_ERwAtAAbGd@jBfD|@bGaGjNVvFjAjAjB}BbFuHKe@tQxNiChAtA`ArRkPlBKcHyJNoP{BUzAyQ|AEnA}FgA]cBoALaAfJrApBhEbAO|Fq@b@iAkBkBfB~@`CiUwHj@hIk@vH|@`Gc@lDwAo@mBj@eAxJnKzLBjF}LbBoEvDvDpI|DpBcArD~ApLmJGeA`F}Gv@eJiA_A~@BfHbFFzMxEIhA{Gk@iArAZ`ApLbEkCrJuBeA_SaB_IhBf@hH~HlDbDChDmC`Ju@~Bx@_AzKxE~ER`DlEeA^eM~D^^qFtAmAjEhAl@nBvAaAtBhB`HcDdEaG`KpBoAnLZfEfCbBuDxSH~FvADB`BjDh@`Fi@ApDYzEkAvAgFp@qDzCo@|BwCfAQbIbMfCzIZoBbIk\\~GgF{B{BP_B|@uAbFkDa@gBgDmC{AoDOaAaGiD{DcFRUeBiFd@aBuAgGi@oAcNsPzByBhImF~CgDzKqQ_AwJtRs@|GsIdEQfEoLEgCqVeFwC}HbDiBbEMjFmDqAkKdDoIhKhDfDyBbHa@rG_SaDJgI`A_CgBw@iAqKaMAs@eB`FaF|AGlAsMsAaOhCoHtZ|@bCkBd@fBpCu@hHhD`EsFjHa@xDzAdE}BxAiZlCIn@_AcAq]f@yApLeB|CkB~ETr@uQMo@aFTCeA~AaRgBcHh@oNaCw@gI{LEqCjBc@~IvAeEgLaEqDXgIrCc@`I{F|EYvAiMnStDlBkK~UjMhGoEc@{W~H_@QcCoCoAs@yEsGmG}BAgBtJeLz@m@gMgOg@wCfA_ArEJxPxDvF{Hl@mIkDuDUXdAqHp`@mQeDo@}JuEkA_DyFoIeBk@{CsEsD_E_AmBnABhEjG`RlDjCMx@}OyAJkDiByJ{IyBGy@wBYUqBoF~@_@m@LsHcA{ExBcEM{UxBIHsG|C{L{PaG}DrFgIt@uFxCuIg@_KgCeKlBPfBgAvBwDpAWjAhElHZzFcGtByMM~A`HcIhAqDhKVvG~HnIlIDlBgB`JaC~D`@jByDBsD`TsAlCcDdG[~BfB|BhL}CbD}G?oCrC_C`JkKwA{LJeCvp@{IsByVVnDbQfD|AlAvCeA|[}LbV`AdMfAdAfQvBzHpHtHFvChBxBo@?mDjD`B~Ds@vJ`@jDbHfAhKoEdCsCjIiBe@oE|CL`HdEfS_EzLt@nGa@xEdApCo@hEoJpCgF`EyAs@kCiKmCkDoLdFIlJmDhMuJtEaDxDmTe@cEi@oAsGqLaHlDsHbFeFuCmBmZn@JqGoAqA{H}D}G_AwBxb@VxIfCxG~BvAj@lIcVnE_I|McAlNyQzImTxDyC~HsTuDeZg@uH}EaGKoSwHkJdG_NrBcAiVsAHTaIuJ_@LqH}Ce@}AfDeIdAaBaEgB{@_D^cFy@_DdBmESAnCcBLqBWHsI{WcC{ThArApNxDjDGpA_GrGRnJoBzJ@jFuH`Bc@_GmFcBc@eCeEmA}NnBcKvE}IwAgIgMfGyLj@kGjKoOzFwEvH{AsB}IlAqGq@aEhA}@RgPbFuGvAcMkBl@iCyAg@aGwA_AVc[fDWbHvBbBaMc@}HeNg@gB{Df@wJqVkHeQk@eC}IiIoDyIYOdJeCdAcCaBFaLgKeCsNzBiNrI_AxKoFu@Y{DsIuCHsNaDXeCtJgKs@q@pRsWjCvC`Vk@bHgD}@qDZkAt@iApEgFnEwCTkAoAeIs@}G|IiIuBeJrCuCxDgA|EyEViGvCoJlMoGJvAa`@ao@m@_c@sBmCyWoFyFpPwToTgDwRj]eJaDc@`DuE?eAbQcEnAmH?sDcEm@vAgKkCj@gC_Jk@u@tBmNU|@dEcFbPyIeBk^_TmGuH_Oye@gFuV_E}g@rEoVcBqG`Dwb@`E{K_Dq^tGkWlDgf@fB_JTgT`CwFoBaKhD}FlGsFfEaMf@qTuEiJ[eGzDsJDcNzDwGh@mLoEkTt@kDa@mFyKyJYmF`Mg]CyUfIiL`BcG}W{IFaCwAYn@}EvPk@@}DzDJxAaIpEFbCqGpAX|AyGaAeGt@{LcDS{ChAu@aH^iGuAcJiJBqDoEqCeAqChEgFcB{CaKgBaOeFkLwVDaK_DwMbAgDyA]mG~GcPKuFgCuDyEJqDmBiDuIP{KiJqKqE_Ll@y`@~BwNfNyg@q@oD}JsPuKcH_A}NlDcMlCG~IcJlKgGlG{X~EgGuCiIsAmRwAcD{FiDuEqJsQaLwJe@iVhDuEQcAoLbBmItc@cIIeCuJqOsHXwHkAcGxDqOlEsDSsHqNeF}T[wLgQmM_@wIlA_NnF}JgA{FlCqHeCcFi@eFjJoNvAyFsF_]{DmFiC}@uSg@{DqBu`@qAcH~JqCvA_GUwHnAoZk@{Kq@kEcL}JrIkDb@oRyDsCoBeAeG_BiB{N{AmCyBrBkLGwDcGgKm@gJuBoGjAqFmA_O|@qWaF{H_McC_C}C_AeEEqOiEqEy@gDfB{LGuHeJkTqKkIgAgCzEgOZuEcEaHyHiF}CaKzAeSe@cF}OyJ}FqSReE|A{BrHeChJaJ[oEuFsMrDmP|FcDtRoBfJgIbAqNqA}HwCmGqLiIkVoJcCoDoBwMaIeD}E}GgCy@mJXsQmHoLeAsGfM_KVkBdO}DfEwIzAuRcDsByO_JqD}Dv@eDc@cCmCoDLTeTsKgA`AuII_DuAU\\aKqIcFj@}GyFmAPgCcCoFmLiCpBsDlFpBhDi@dCqBjAsGsCkB`GuGpBmNeCwAsAsF|EyFxHfAjAo@`AcHlKrAnBgGzFlApJJzAiC~HaD|E|@|@gDpBCr@mFbHbAdDkTnEr@S_DjFlBtGwC]_B{CLVaBwCiCMiCyH_A{@jP[h@kAeAsBlAw@sAfGkQj@yG|Fo@z@aGxFuGZaExNI~@_LxCwCxBsGt@a[vCgKiEyBBcAeBq@R{@qEaEiAeIcChJyI~GmBfGeFv@{KqCcHzAwBWt@iAsC_FJqFiHB_CfDyFgGyErDqBdEwA@wNz\\zGlCqDnKGtCvQlAcBzF}M`UiKns@eHwG_JkE}CuKaEB}CrBm@rBkIo@_@nAoIlC_CsByAuEyEmCLsDbJ|@|IuHpJyBxCsOqKiCKqKkDw@iCcEuJwBuAjCeMaFmDFbAoGkC_IqD{DBkDmKgJfDgKlEcC|B{Ga@uD|@oEr@wAdDj@zGoPlBF~FzHpFdAt@}AHgKeAm@q@oJ_DqA`A}WpAMdAkD`D_[jCwGnCqQtDgDqCaFaL}Gk@yB}AXiAdDsO{DyInD}AMuBiEsRWjEaVcAuCkMKqDfCcF_@qEhAiDu@FyLfHmJb@iDrA?s@c@LuBtEkMsAyGjAcJkHyIcG}C_CJxDiNkCyLYgOiB{Im@aOeJ{HgBEcIvDsIPmU_Gk@uLrBoNoBoE|CyP{BiA{AcEuFyFuS_LaLh@eGfC}Fd_@kF~GgEpU_CbBf@z@lFRCnDmAfE}DzDqHYJfOgL}DaA`ImEa@mIjBqEzDGhC|LjN{EpIkB`g@uG\\mKdHyEr@oTdRs@zj@vA~HwB~NoIfBsEaC}AcDx@{MiHgKsCo@sA`DuIcCyA~@k@`Cl@dDeAtBgB}AwGgA_Wl@M_FiEt@nBsBuAuDr@o@kDc@VsCwBa@XiJ_IoGaAeBBmDhN_FtAkCzB}MeB{DzAoEzIcCjChMbBoXb@x@lD_@hDoCEkCaJiBlA~AgBnCgFBU|@}AmAnEcHpAE}@mCiGE@dA{NxEAaEqGp@YmGsJhGmIeCeYak@rBiSvTwe@_Aak@hCg\\xAeEbD_CNkCmLCcA{AL_E|BoCiJ_JCiAfCeCmFyPE_BrN{EVqAaBqDg@sKqBaE^qByAkOgEaDa@wB|GsXeE}AJkCkG_HyFoDsGy@}FmE}@iDx@yFmF}CcAgC`PaDb@o@gBmFqVi]}BuFaO_IuBeEoHwg@}DoOsGeIiDmZmJ_Km@iEmCs@kAmHiBMcE~AeFk@kCuK{AsA`AsBnDq@VcNsGsBmB_CvC_JvCoCqAcKnAeA?iD`IqA_DcEjAeC}@iH|LoH|DtApAeEy@qHrCqAfDwFFuI~D{EkAaJqN_CcHrBiBjBmAeCeFgAmCwEJ_BsBgA]qD`@uArA`BjDV^eFnDt@k@{Dl@cAmAc@wC`AeAmA^eCjCwAcAmCmLqEwAhAkC_@gEt@g@dD{K~AmAo@eAb@sDyCkFv@c@c@|CoGvCaDq@gBeEsAmN~JS~IaFjKsKtAeCsGyFkFiDtFmDiFmFn@gPmEWmHhAeCw@sE{I}H}Ik@iEf@y@fAA~GxF|II|C_BlD{AZoAkADwAgHyHcD[WmA}Aa@qDqHaKMiA~AoG`@_@nAkIhEqEmI_G_BmAsDwGoC{QkT_BdA}HuEkCeFgKsHuCoEWqBvAiBfAD]hDdAt@dCuBbBJzGgJyAmEf@}E`BwBlBdB|Aq@nB|@bCaCzCbBbAyBbFlHr@_EdA^h@_CzGuBqB_B{Cd@rA{B_@sBlCuC|FvDtBJxCnDxAAhAkBbCbErBk@t@}EpA_AoBuCjBuDe@iApD{CmAyAh@kCnDmAi@_CvD`@dCs@`CeHnDrBE~FtCSfDqCxCXh@hCq@zCdGxFzB_A]oEvBu@rF`Al@bA|Au@vDdC\\kD~DSBiCjC{EzEeDfEuG_GeHsJ~DwFkEsDtDsFXIcDvBwBi@sEaD_Et@oDcDuD]cHwDwBi@cEvA_E{@_@LcBuAx@}@{AEyFcAqAqB?bAcBqAsE{Dk@oGmGyJxCoAyEmEn@{EyCy@zE}JdBsK{KMkGjAuChAIlDqKhG{BkA}AvBeHoBoL\\}AjLq@xFfCrEsB~AgBBqCxAg@{BcB@eBvBm@lBoDl@oHaBaFnCuByCwIaGaADmBgCiAx@kDsBaCAeDw@QzFeMQ{EsMeMsBzFoEnCeA_DkC_@_BvCj@rDxCl@FpAiDhB{CQiCzBMnDwCdAmQcTkEEsJiKyFu@{FoFImA}Ba@iCzBnAjHhDzEy@zHoArAqOdGcG{E]wFgEEN|DpDvJqB`FqEUe@tGeGD{HkIwEnCsD{GiAgKgCyFuJyA_JyFCpAoAYyJkKgCs@i@gCoHmCoDiGeAe@_Bz@m@~BwI{MzDmGnDiC\\gCuBiElJiJr@eFjGqClBDwGoBkEmDkIvA{@e@zDuN`@sO{BoBqFb@}G}DwDoNz@cEq@sD}Et@cMaWAcAxEqE}DuMw@o@}JP}F_DoBfJiHtGmAZcEcFw@lCXdIkK`G_G[DmGkK\\y@~HdLb@`AhAjGc@\\tFqDtDyCZqA{FqBYeC~BoCQyDnGkM`D\\}MkE]}FuDf@iIhBaAlBTjAuB?iFmCqIbBeArAsHxEf@bHmL~DiChBZdBmIgGwCqETi@vAaF}@F|EcJjB{@g@HkE`ByFmAkC_Fz@sFy@sDlF_Jj@gBjBcGc@[aG_BNo@hDyBSl@wHdBo@bDlAzHiIkDoFbHuBlDf@hJ}@`@pAiCrBNvD|@f@vEqApCwJP{HaReCiH{GaMpDqCwCDyBfH{BzBbBzBIAcLcEq@iId@{CiEJyEcA}AkLzFaGIeDiDXkEqEmBs@}AmFZ`A}C~BgAjHdAzAu@hAmJ~CWLvAnAb@dDk@PoAfFsChILdDaGfCa@`CaDrSyHbAaQxFlArA|GnAJlD{AdCwJxGEnMmCvByBxI{BUkDdF_CpA_CL_A_CoDaFz@}NvHr@|Bm@~AyGZiDpCcFj@kB_@{DiEgBeI}EuDE}EzIcArEcFxPsFfKXfFyCxFrAlAyB}@eHtK{AtHnB~CGhGcCtF{KxKuBWcGzGiA{DkD_@sFbEuJEoClE{BIwDwBaCUiDpAmJ{AwDF{HbCuF{AsCd@gAhEgAbCqG`GWp@{DdIoCv@qFtAmAq@kCd@y@_E{HEcCfCoD{AcCgD^eAcA{EqKL}CtBVBqLiDa@i@aBv@mAqEmOz@wCy@u@\\iAlBIvCcLmJyRtDiIp@qFkC_AsBiIsIx@y@eH_C`A_Aa@U{DuCgAgBfDQrDqHlAmHc@nAgD~EcEiAmA`AkCqHaC_DbJ}Cl@bCcMnCuDgDwAiB\\}BnJiCn@hEiS{C{GsFtBe@cArCgDeGcFcNhF{EyCkDj@q@{@FmEgDiDeCbCaCX}A|EoEDyDzEuCPl@sAtBCFkC`CiBMiAvASPmDfB_EhAB^wAu@KdBsE_EwBcIUmGwFyAmEaHsEb@yEiDuG_@{HyHwGSu@nA^ZuA_CkBpNMjCrABwAbFVbDeFo@oCwQ_Gm@aD_BhAqAy@DmDpB}@G{A{BkBUaFpAoBmD}@gAaC_JxDa@fFhEjHClBiDrAqCQFfGyNxC}@jCy@F~AwRy@mIu@U`A_DUeGyIyA}Gh@sAsADiBtBgCh@gPvA_@jB|@n@fElBqA|FvBhD{@~Xaf@`IvE~|@dn@z`@bc@tPrN`LbGjLzCfKfIxNnBt_@fe@p[rVpKdFfGp@~g@`k@zHdEhMjAtt@p`Ary@p{@tRdHg@_AhItFrGLlB|A`Ut`@n[ny@vJrQhIlb@xBzFpHhJ|Qro@jOr_@fXdi@dh@nx@jGtE~D_@lBt@bKdHhGhGx[`l@pChAtDGzG~EhLdQnFzAjB{B|FBjF`CxMpMtDTvKdRtJzExFc@vHpPjEdEQj@dAIg@Xz@pAz@{Aq@Q]k@xDd@gCzCnB`A?dFi@JDoBOC?bBkKFlIbAoFvC{AIG~AfAc@gAxBj@\\fAkAt@~@a@kDzEeCM|Dp@gE~Aq@\\qIbEv@bIfGpDxJvClAdDhHlCq@{BhAbDlDW|@v@_@x@tAVsBfBkAiDuDBGjFjEnG`LnCfAzIpW|@`AdA]dCdE`J~c@bEpHdO`i@|E~GzCZrDnEfAO~@dAdGzT`Zju@vHpYpW`u@pXfp@p[lp@d[bj@dYva@jZp^pt@~v@zT~M`WxF?mAd@AO`DhBS^qB|J~A@rEbBK|@yAfC`ApAfFg@pGh@uD~BpA~La@\\`ArAkCzHoAf@oBlDsB@_FjB_Bn@yDxJyIkByL|A{InAO{Ae@~XpC^w@rb@|EpCm@z@gNjFEhGpAd\\jSnNtFhOvBzMuBpLbItInP`c@npAtz@nrBLrDtCdDpBbT|Hv`@fTnj@bLv_@tClDaAbALxDgC~JiGxDgK|~BnEbs@zKja@|JrU~KtP`KjJhLbIv`@fR~RDjR|Ef`A`c@dMl@lLq@bf@tj@lp@vh@dMhA|@bB~AGhMeF_DLvFaCWq@_CHjH}@DfCbHvGdSnb@m@jHzExi@g@tRwCdD{DrA_GdI{LhDqEpCyMvC_Be@zCm@xAmBtSeEtCwCdC]jBuBWsD{h@vKsB?q@gA@_FiFe@oDz@}D~DbC`EsG|F_JpRsB~K_AhQbAh^tFbd@|Gn]~Qnm@zQvb@fTn_@rTvW`S~PvKpHtCVxR|JvQxF`ZbFnIwArL|FpJj@xTjH`n@jf@d[fPnMbBrMhFvPlDhHTxTqAjQx@jYzKfVbFxP|Alt@uCbi@kG|[{Hna@{@n^}ErScGlF}HfN_Hdi@yI`NeEdIoGq@Kv@yAdFyBrFC`h@|GraBjF|o@tP|LEbHvB~PbBn^h@tc@{Blj@aJdgA{]xTsJfSgE`P}F|WyEll@bIx^j@pXkDb`@aOHpA`x@rL_A~CyEfDMzEwACFvAnA\\wArOn@fJ_A`KeEJeAhBl@vB{@`LfFDnBlA}AtAzAxBQbKsTZqF_FgGnCdBbGWtB`DpB_@vO}CfCGxEtA`GvIO}@qJ|CBWo@~CoBwAeDhBkGlKp@wBjHAtGnKnDMvMtDb@`@rElWIxBrEUvLzCYDrBjDqEzChA`A{@^aJzHjBj@xA{AhAJbA|Bk@hHzBfDjEoCdDWhCjFj@~C~EfCpJ|D`AmBzDdHfCmArD`BLgApY~I`FnBxDDjAuLtLIlAdKRjAz@xBnEWpEx@lAzDg@dDaIbEgDzH_TfBgAfEl@E|C~EnEAxEbE`BUzCiFp@yHdH`H|@BtDfBxBsB~FqDu@aCmDcFzA}@zABzBdGdCuEpE}Et@}AmC~@kCoAWuA|AOmAeAKsGdFaDp@fAlApETbAdCUnA{Ai@wAj@vAhDkC~BF~B`Hx@uEnAvItBwF~HdAhDyDXLtBbAlAzKj@tAjBAlFoFpHUzLuAvAoIkBkB~@sBUsEaCqCjAmEImEnFZhIrCr@eFjIlBnFZtGoAn@n@zEuCfDWtCzFzCFtC|AvCaAjDfBfChG_@BjG`CbBt@gC~EC{@{CFaIPcAtCy@qE_GHyGzD\\l@vEtGn@p@jFfC|DlAgBnD]n@oBvAzAfAg@M{GpAl@GgB~CrCcC}IVeCdJb@t@xAs@bEj@XpB[z@mBtFxExCqBmBjQ^fC|AbAqBjCt@fIdAd@hAkFlA]]`Dv@~B|Bv@DqD~CT_AzHh@pAtTgCnCtCDfEwHh@Ir@xBt@LhDhCpEjB_At@rE^cBbDzFcApDaE_B_D}D|@tNsQ`Ca@nBnCpEaFvA`@nBvFMnCtDgBhAqDkAaJz@@xCtHjD]xE~ClAr@wDpDoFzFPjBeClGvAvH~QdCtADpAqBpArAbAIrBdGcAXoCfD|A_@nCn@Zv@Qh@cEZrD~AI|A{EhHjD|DdKq@|E}F~L_@jHFjCxE`EUrJwGlH{EVmEzOwDVmBrLqFrMhAjHrClBd@hG_CxDlA`Ca@xHvFl@t@b@JzDhKhCCsMxDoFbAl@k@rCl@rV}Y|@cLgBi@`D\\`FnG~BG`HfAlGgE|Ln@pC~LpMfEtUmCtDeCfP|_@vE}G`\\pJhB~EbJbBV|BtFjMsNbANWdD~G}B|JuGlApAwAhK|I`ArRfHrHd@lJpFnQ_B`@vBdGCnCnC`HJjFbI|APAnBfDdBh@jDfCwApF`B\\gDpJjDhDmBlAdBnBA~CbLiGpBwBIr@}Ae@sCuBnH{BbBmF@_@^`EBBnBaDb@wCjCqA|FrAbAnF_GtBk@zBsHr@A|A|@b@xByC`CbEF~@dC~E}E|HnDrA`H{@hItMc@DcAz@CFfA~IEjB`BiAbAq@fHbAhFqBbCtAjIXxXoM~PM~EwEnF}BzGZjBoLxFqHvFgAxCMrMjCtBhGTSpLn@hBsAKq@|@W|CmD}D}B|@TqBsACj@oB_CuDn@iA{IiEgRfE}LgHsWmC{TNiAeA\\wDwBuASyApDyDFqRyD}@";
/** Yanam: inside the outline, not in the state. */
const HOLES_ENCODED: string[] = ["kteIeidq@nK_k@LiNi@uDiL{IsK|C|BnClCb@nDrCSfGpBzBXbFi@bLqBtBoBfHuDc@mCcCoAZi@iDuBpAnBbA]vA\\s@vBx@s@dBt@jAvHtBk@|JbCAKsCfB\\"];

/** A Google encoded polyline back into [lat, lon] pairs. */
export function decodePolyline(text: string, precision = 1e4): [number, number][] {
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = text.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < text.length) {
    lat += next();
    lon += next();
    out.push([lat / precision, lon / precision]);
  }
  return out;
}

/** [lat, lon] pairs, closed ring. */
export const AP_OUTLINE: [number, number][] = decodePolyline(OUTLINE_ENCODED);
/** Rings cut out of the outline (Yanam), each closed. */
export const AP_HOLES: [number, number][][] = HOLES_ENCODED.map((ring) => decodePolyline(ring));

/** The state's centre, which world (0, 0) sits on. */
export const AP_CENTER = { lat: 15.9, lon: 80.75 };
const KM_PER_DEG = 111.32;
const COS_LAT0 = Math.cos((AP_CENTER.lat * Math.PI) / 180);
const RAD = Math.PI / 180;

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** Latitude/longitude to world kilometres. */
export function toWorld(lat: number, lon: number): Vec2 {
  return [(lon - AP_CENTER.lon) * COS_LAT0 * KM_PER_DEG, (lat - AP_CENTER.lat) * KM_PER_DEG];
}

/** World kilometres back to latitude/longitude. */
export function toLatLon(x: number, y: number): { lat: number; lon: number } {
  return { lat: y / KM_PER_DEG + AP_CENTER.lat, lon: x / (COS_LAT0 * KM_PER_DEG) + AP_CENTER.lon };
}

export interface Camera {
  /** Orbit around the vertical axis, degrees. */
  yaw: number;
  /** Tilt away from straight down, degrees. 0 = map view, ~60 = oblique. */
  pitch: number;
  /** Screen pixels per world kilometre at the focus. */
  zoom: number;
  /** The world point the camera looks at. */
  panX: number;
  panY: number;
  width: number;
  height: number;
}

/** How far the eye sits from the focus, in km — larger is flatter perspective. */
export const EYE_DISTANCE_KM = 1500;
export const PITCH_LIMITS: [number, number] = [0, 68];
export const ZOOM_LIMITS: [number, number] = [0.25, 12];

export interface Projected {
  x: number;
  y: number;
  /** Positive is farther from the viewer; used to paint back to front. */
  depth: number;
  /** Perspective scale at this point, for sizing markers. */
  scale: number;
}

export function project(cam: Camera, [wx, wy, wz]: Vec3): Projected {
  return projector(cam)(wx, wy, wz);
}

/** `project` with the camera's trigonometry worked out once — the map projects some
 *  twenty thousand vertices a frame, and the sines and cosines never change within it. */
export function projector(cam: Camera): (wx: number, wy: number, wz: number) => Projected {
  const t = cam.yaw * RAD;
  const p = cam.pitch * RAD;
  const [ct, st, cp, sp] = [Math.cos(t), Math.sin(t), Math.cos(p), Math.sin(p)];
  const D = EYE_DISTANCE_KM;
  const cx = cam.width / 2;
  const cy = cam.height * 0.5;
  const { panX, panY, zoom } = cam;
  return (wx, wy, wz) => {
    const x = wx - panX;
    const y = wy - panY;
    const x1 = x * ct - y * st;
    const y1 = x * st + y * ct;
    const up = y1 * cp + wz * sp;
    const depth = y1 * sp - wz * cp;
    const scale = D / Math.max(D * 0.15, D + depth);
    return { x: cx + x1 * scale * zoom, y: cy - up * scale * zoom, depth, scale };
  };
}

/** A screen point back onto the plane at height `z` (km), as latitude/longitude. The
 *  inverse of `project` for that height — what "click the map to pin this point"
 *  needs; the map passes the height of the ground it drew under the cursor. */
export function unproject(cam: Camera, sx: number, sy: number, z = 0): { lat: number; lon: number } {
  const a = (sx - cam.width / 2) / cam.zoom;          // x1 * scale
  const b = (cam.height * 0.5 - sy) / cam.zoom;      // (y1 cos p + z sin p) * scale
  const p = cam.pitch * RAD;
  const D = EYE_DISTANCE_KM;
  const [cp, sp] = [Math.cos(p), Math.sin(p)];
  const denominator = D * cp - b * sp;
  const y1 = Math.abs(denominator) < 1e-9 ? 0 : (b * D - D * z * sp - b * z * cp) / denominator;
  const scale = D / (D + y1 * sp - z * cp);
  const x1 = a / scale;
  const t = cam.yaw * RAD;
  const x = x1 * Math.cos(t) + y1 * Math.sin(t) + cam.panX;
  const y = -x1 * Math.sin(t) + y1 * Math.cos(t) + cam.panY;
  return toLatLon(x, y);
}

/** Points along a raised arc from `a` to `b` — a route leg lifted off the map so
 *  overlapping legs stay readable. Height grows with the leg, capped. */
export function arc(a: Vec2, b: Vec2, base: number, samples = 24, baseEnd = base): Vec3[] {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const lift = Math.min(70, 6 + length * 0.22);
  const out: Vec3[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    // The two ends may stand on different ground (a hill town, a delta port).
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
      base + (baseEnd - base) * t + lift * Math.sin(Math.PI * t)]);
  }
  return out;
}

/** Zoom and pan that frame `points` (world km) on screen with a margin, from this
 *  yaw and pitch. Measured, not estimated: perspective enlarges the near side of a
 *  tilted map, so the camera is projected, its box on screen read back, and zoom
 *  and pan corrected — three passes converge well inside a pixel. */
export function frame(points: (Vec2 | Vec3)[], width: number, height: number, pitch: number,
  margin = 0.08, yaw = 0): Pick<Camera, "zoom" | "panX" | "panY"> {
  if (!points.length) return { zoom: 1, panX: 0, panY: 0 };
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const cam: Camera = {
    yaw, pitch, width, height, zoom: 1,
    panX: (Math.min(...xs) + Math.max(...xs)) / 2,
    panY: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
  const usableW = width * (1 - margin * 2);
  const usableH = height * (1 - margin * 2);
  for (let pass = 0; pass < 4; pass += 1) {
    // A point may carry the height it is drawn at (a beam's head, a stop on a hill).
    const drawn = points.map((p) => project(cam, [p[0], p[1], p[2] ?? 0]));
    const sx = drawn.map((p) => p.x);
    const sy = drawn.map((p) => p.y);
    const [minX, maxX, minY, maxY] = [Math.min(...sx), Math.max(...sx), Math.min(...sy), Math.max(...sy)];
    const factor = Math.min(usableW / Math.max(1, maxX - minX), usableH / Math.max(1, maxY - minY));
    // Re-centre on the box's middle, then scale about it.
    const here = unproject(cam, (minX + maxX) / 2, (minY + maxY) / 2);
    const middle = unproject(cam, width / 2, height / 2);
    const [hx, hy] = toWorld(here.lat, here.lon);
    const [mx, my] = toWorld(middle.lat, middle.lon);
    cam.panX += hx - mx;
    cam.panY += hy - my;
    cam.zoom = Math.min(ZOOM_LIMITS[1], Math.max(ZOOM_LIMITS[0], cam.zoom * factor));
  }
  return { zoom: cam.zoom, panX: cam.panX, panY: cam.panY };
}

/** The outline in world km, computed once. */
export const AP_OUTLINE_WORLD: Vec2[] = AP_OUTLINE.map(([lat, lon]) => toWorld(lat, lon));

/** Ray-cast point-in-polygon on one [lat, lon] ring. */
export function inRing(ring: [number, number][], lat: number, lon: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [ai, oi] = ring[i];
    const [aj, oj] = ring[j];
    if ((ai > lat) !== (aj > lat) && lon < ((oj - oi) * (lat - ai)) / (aj - ai) + oi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Inside the state — used to show a pin as "outside AP". A point in Yanam is not. */
export function insideAp(lat: number, lon: number): boolean {
  return inRing(AP_OUTLINE, lat, lon) && !AP_HOLES.some((ring) => inRing(ring, lat, lon));
}

/** "16.5062, 80.6480", a Google Maps link, or "16°30'22\"N 80°38'53\"E" → a point. */
export function parseCoordinates(text: string): { lat: number; lon: number } | null {
  const raw = text.trim();
  if (!raw) return null;
  // A Google Maps place link carries the PIN as `!3d<lat>!4d<lon>`; its `@lat,lon` is
  // only where the map view was centred, often hundreds of metres away. Pin first.
  const pin = raw.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (pin) return valid(Number(pin[1]), Number(pin[2]));
  const at = raw.match(/[?&](?:q|ll)=(-?\d+\.\d+),(-?\d+\.\d+)/) ?? raw.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at) return valid(Number(at[1]), Number(at[2]));
  const dms = [...raw.matchAll(/(\d+)[°\s]+(\d+)['′\s]+(\d+(?:\.\d+)?)["″\s]*([NSEW])/gi)];
  if (dms.length === 2) {
    const value = (m: RegExpMatchArray) => {
      const v = Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600;
      return /[SW]/i.test(m[4]) ? -v : v;
    };
    const [first, second] = dms;
    return /[NS]/i.test(first[4]) ? valid(value(first), value(second)) : valid(value(second), value(first));
  }
  const pair = raw.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
  return pair ? valid(Number(pair[1]), Number(pair[2])) : null;
}

function valid(lat: number, lon: number) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Bounded to India, the same bounds the server enforces on a pin.
  if (lat < 6 || lat > 37.5 || lon < 68 || lon > 97.5) return null;
  return { lat, lon };
}
