// ========== 自适应精确计算版 ==========
silent = true;

const CONCURRENT_COUNT = 50;
const STEP_SECONDS = 4;
const BATCH_INTERVAL = 300;
const MAX_BATCHES = 50;

let batchCount = 0;
let inferredDuration = 0; // 反推出的视频总时长

function sendOne(seconds, id) {
    return new Promise((resolve) => {
        var data = [{
            'index': 0,
            'methodname': 'mod_fsresource_set_time',
            'args': {
                'fsresourceid': playerdata.fsresourceid,
                'time': seconds,
                'finish': 1,
                'progress': 100,
                'unique': Date.now() + '_' + Math.random() + '_' + id
            }
        }];

        $.ajax({
            url: playerdata.siteUrl +
                "/lib/ajax/service.php?timestamp=" + new Date().getTime() +
                "&sesskey=" + playerdata.sesskey,
            method: 'POST',
            data: JSON.stringify(data),
            success: function(response) {
                const progress = parseFloat(response[0]?.data?.progress) || 0;
                const totaltime = parseInt(response[0]?.data?.totaltime) || 0;
                const duration = parseInt(response[0]?.data?.duration) || 0;
                resolve({ id, progress, totaltime, duration, success: true });
            },
            error: function() {
                resolve({ id, progress: 0, totaltime: 0, duration: 0, success: false });
            }
        });
    });
}

async function sendBatch(count) {
    const promises = [];
    for (let i = 0; i < count; i++) {
        promises.push(sendOne(STEP_SECONDS, i + 1));
    }
    const results = await Promise.all(promises);
    const successCount = results.filter(r => r.success).length;
    const maxProgress = Math.max(...results.map(r => r.progress), 0);
    const maxTotalTime = Math.max(...results.map(r => r.totaltime), 0);
    const duration = Math.max(...results.map(r => r.duration), 0);
    return { successCount, maxProgress, maxTotalTime, duration };
}

// 根据本批结果反推总时长
function tryInferDuration(progressBefore, progressAfter, sentCount) {
    const progressGain = progressAfter - progressBefore;
    if (progressGain <= 0) return 0;
    const secondsSent = sentCount * STEP_SECONDS;
    const inferred = Math.round(secondsSent / (progressGain / 100));
    console.log(`   🔍 反推总时长: ${secondsSent}s / ${progressGain.toFixed(2)}% ≈ ${inferred}s`);
    return inferred;
}

// 计算下一批需要发多少个
function calcNeeded(currentProgress, currentTotalTime) {
    if (!inferredDuration) return CONCURRENT_COUNT;
    const remainingSeconds = inferredDuration - currentTotalTime;
    if (remainingSeconds <= 0) return 1;
    const needed = Math.ceil(remainingSeconds / STEP_SECONDS);
    console.log(`   📐 推算总长: ${inferredDuration}s | 已观看: ${currentTotalTime}s | 剩余: ${remainingSeconds}s → 需发 ${needed} 个请求`);
    return Math.min(needed, CONCURRENT_COUNT);
}

async function mainLoop() {
    console.log('🚀 启动自适应精确刷进度...');
    console.log(`   最大并发: ${CONCURRENT_COUNT} | 步长: ${STEP_SECONDS}s\n`);

    const probe = await sendOne(0, 'probe');
    let currentProgress = probe.progress;
    let currentTotalTime = probe.totaltime;
    // 接口直接给了duration就直接用
    if (probe.duration > 0) {
        inferredDuration = probe.duration;
        console.log(`📊 初始进度: ${currentProgress}% | 已观看: ${currentTotalTime}s | 视频总长(接口): ${inferredDuration}s\n`);
    } else {
        console.log(`📊 初始进度: ${currentProgress}% | 已观看: ${currentTotalTime}s | 视频总长: 待第1批反推\n`);
    }

    while (currentProgress < 100 && batchCount < MAX_BATCHES) {
        batchCount++;

        const needed = inferredDuration
            ? calcNeeded(currentProgress, currentTotalTime)
            : CONCURRENT_COUNT; // 首批或推导失败时用满并发

        console.log(`📤 第${batchCount}批 发送 ${needed} 个请求...`);
        const startTime = Date.now();

        const { successCount, maxProgress, maxTotalTime, duration } = await sendBatch(needed);

        // 接口直接给duration就优先用
        if (duration > 0 && !inferredDuration) {
            inferredDuration = duration;
            console.log(`   📡 接口返回视频总长: ${inferredDuration}s`);
        }

        const elapsed = Date.now() - startTime;

        if (maxProgress > currentProgress) {
            const increase = maxProgress - currentProgress;
            console.log(`   ✅ 成功${successCount}/${needed} | 耗时${elapsed}ms | 进度: ${currentProgress}% → ${maxProgress}% (+${increase.toFixed(1)}%) | 累计${maxTotalTime}s`);

            // 若总时长仍未知，用本批数据反推
            if (!inferredDuration) {
                inferredDuration = tryInferDuration(currentProgress, maxProgress, needed);
            }

            currentProgress = maxProgress;
            currentTotalTime = maxTotalTime;
        } else {
            console.log(`   ⚠️ 进度未增长，当前${currentProgress}%`);
        }

        $('.num-bfjd span').html(Math.floor(currentProgress));
        if (maxTotalTime) $('.num-gksc span').html(maxTotalTime);

        if (currentProgress >= 100) break;

        console.log(`   ⏳ 等待${BATCH_INTERVAL}ms...\n`);
        await new Promise(resolve => setTimeout(resolve, BATCH_INTERVAL));
    }

    console.log('════════════════════');
    if (currentProgress >= 100) {
        console.log('🎉 成功达到100%！');
        $('.num-bfjd span').html('100');
        console.log(`📊 总批次: ${batchCount} | 推算总时长: ${inferredDuration}s`);
        setTimeout(jumpToNext, 1000);
    } else {
        console.log(`⚠️ 已达上限，当前进度: ${currentProgress}%`);
    }
    console.log('════════════════════');
}

function jumpToNext() {
    const url = new URL(window.location.href);
    const idStr = url.searchParams.get("id");
    const currentId = Number(idStr);
    if (!Number.isInteger(currentId)) {
        console.error("❌ id参数不合法");
        return;
    }

    const SKIP_IDS = new Set([2119410, 2119427, 2119443, 2119460, 2119472, 2119340, 2119354, 2119376, 2119396]);

    let nextId = currentId + 1;
    if (SKIP_IDS.has(nextId)) {
        console.log(`⏭️ ID ${nextId} 在跳过列表中，跳至 ${nextId + 1}`);
        nextId += 1;
    }

    url.searchParams.set("id", String(nextId));
    console.log(`🔗 跳转至 ID: ${nextId}`);
    window.location.replace(url.toString());
}
mainLoop().catch(error => {
    console.error('❌ 脚本异常:', error);
});
//author：hourizon
//特别鸣谢：thx lbyxiaolizi,Zikiviki,mzwing等所有为了该项目付出的人
