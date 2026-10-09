-- 20261009：超限素材组 Lua 绘制脚本
-- 图片数量：2；静态图片资产：1 种
-- 1. 准备一个客户端图片控件，设为「仅存为模板」。关闭模板遮罩/羽化。
-- 2. 必填：将下面 IMAGE_PREFAB_ID = 0 改为该图片控件的「控件模板索引ID」。
--    不是图片资产ID；只填这一处，脚本会自动切换每个图元的静态图片。
-- 3. 挂载：创建专用空客户端容器节点，将本文件作为客户端脚本挂到该节点。
--    进入运行预览即绘制（OnStart）。脚本会设置该节点尺寸，请不要挂在已有界面的根节点上。
-- 可选：BASE_SCALE 缩放；OFFSET_X/Y 平移（Y向上）。自定义图片需在当前关卡可用。
-- 保留键鼠布局；不转换嵌套组、文本、动态引用及组遮罩。

local IMAGE_PREFAB_ID = 0 -- 必填：客户端图片控件模板索引ID
local BASE_SCALE = 1
local OFFSET_X = 0
local OFFSET_Y = 0
-- 数据顺序：图片资产,x,y,w,h,pivotX,pivotY,anchorMinX,anchorMinY,anchorMaxX,anchorMaxY,scaleX,scaleY,rotZ,r,g,b,a
local ROOT = {0.0,0.0,300.0,300.0,0.5,0.5,0.5,0.5,0.5,0.5,1.0,1.0,0}
local ELEMENTS = {
    {100001,-2.9702999591827393,31.188100814819336,102.0,70.0,0.5,0.5,0.5,0.5,0.5,0.5,1.0,1.0,0,194,65,12,217},
    {100001,-32.673301696777344,-30.07430076599121,102.0,70.0,0.5,0.5,0.5,0.5,0.5,0.5,1.0,1.0,0,194,65,12,217},
    {100001,60.0,60.0,80.0,40.0,0.5,0.5,0.5,0.5,0.5,0.5,1.0,1.0,0,15,118,110,255},
    {100001,-60.0,-60.0,80.0,40.0,0.5,0.5,0.5,0.5,0.5,0.5,1.0,1.0,0,124,58,237,128},
    {100002,0.0,0.0,50.0,50.0,0.5,0.5,0.5,0.5,0.5,0.5,1.0,1.0,0,245,158,11,255},
}

local created = {}
local function Clear()
    for i = #created, 1, -1 do
        game.DestroyClientUIControl(created[i])
    end
    created = {}
end

function OnStart()
    Clear()
    if type(IMAGE_PREFAB_ID) ~= "number" or IMAGE_PREFAB_ID <= 0 or IMAGE_PREFAB_ID % 1 ~= 0 then
        printerr("[GIA绘制] 请填写 IMAGE_PREFAB_ID：客户端图片控件模板索引ID")
        return
    end
    local parent = script.object
    if parent == nil then return end
    parent:SetAnchorMin(0.5, 0.5)
    parent:SetAnchorMax(0.5, 0.5)
    parent:SetPivot(ROOT[5], ROOT[6])
    parent:SetSizeDelta(ROOT[3], ROOT[4])
    parent:SetLocalScale(ROOT[11] * BASE_SCALE, ROOT[12] * BASE_SCALE, 1)
    parent:SetLocalRotation(0, 0, ROOT[13])
    parent:SetAnchoredPosition(OFFSET_X, OFFSET_Y)
    local ok, err = pcall(function()
        for _, item in ipairs(ELEMENTS) do
            local image = game.InstantiateClientUIControl(IMAGE_PREFAB_ID, parent)
            if image == nil then error("图片模板无法实例化，请确认已设为仅存为模板") end
            table.insert(created, image)
            image:SetImage(Enum.ImageSource.StaticReference, item[1])
            -- imageType 仅部分图片支持，保留不支持该属性的静态图片。
            pcall(function() image.imageType = Enum.ImageType.Stretch end)
            image:SetAnchorMin(item[8], item[9])
            image:SetAnchorMax(item[10], item[11])
            image:SetPivot(item[6], item[7])
            image:SetSizeDelta(item[4], item[5])
            image:SetLocalScale(item[12], item[13], 1)
            image:SetLocalRotation(0, 0, item[14])
            image:SetAnchoredPosition(item[2], item[3])
            image.imageColor = Color.FromRGBA(item[15], item[16], item[17], item[18])
            image:SetAsLastSibling()
        end
    end)
    if not ok then
        Clear()
        printerr("[GIA绘制] " .. tostring(err))
    end
end

function OnDestroy()
    Clear()
end

-- 编辑器回导数据：保留图元名称、文本框与素材库，请勿删除。
-- MILIASTRA_EDITOR_SCENE_V1 eyJ2ZXJzaW9uIjoxLCJkcmF3aW5nSGFzaCI6IjMzZDAyMjUzOTBhYTM2OTQ3OTgyZjg5YTQ1MTQzOGJlODRkYzdiMTJkNTc4NDZhZjRkYjhjZjkxMjU3NWJkMjYiLCJzY2VuZSI6eyJjYW52YXMiOnsid2lkdGgiOjMwMC4wLCJoZWlnaHQiOjMwMC4wLCJiYWNrZ3JvdW5kIjoidHJhbnNwYXJlbnQiLCJtYXNrIjp7IngiOjAuMCwieSI6MC4wLCJ3aWR0aCI6bnVsbCwiaGVpZ2h0IjpudWxsLCJzaGFwZVR5cGUiOjEsImVuYWJsZWQiOnRydWUsInByZXZpZXdPbkNhbnZhcyI6ZmFsc2V9fSwiZWxlbWVudHMiOlt7ImlkIjoiYjZhNzYyNmYtYjY4NC00YjI2LTllN2MtYjU5MjA1NzQ3MDg0IiwibmFtZSI6IuefqeW9oiIsInR5cGUiOiJyZWN0YW5nbGUiLCJ4IjoxNDcuMDI5NzAyOTcwMjk3MDIsInkiOjExOC44MTE4ODExODgxMTg4Miwid2lkdGgiOjEwMi4wLCJoZWlnaHQiOjcwLjAsInJvdGF0aW9uIjowLjAsImNvbG9yIjoiI2MyNDEwYyIsIm9wYWNpdHkiOjAuODUsInpJbmRleCI6MCwiaXNCYWNrZ3JvdW5kIjpmYWxzZSwidGV4dEJveCI6bnVsbCwiaW1hZ2VBc3NldElkIjpudWxsLCJpbWFnZVRpbnQiOmZhbHNlLCJwcmVmYWJJZCI6bnVsbCwicHJlZmFiVmFyaWFibGUiOm51bGx9LHsiaWQiOiIwZWY5ZjA2MC03NDU1LTQ4MzMtOTNmNy03MWQ4ZDRlODgzNWEiLCJuYW1lIjoi55+p5b2iIiwidHlwZSI6InJlY3RhbmdsZSIsIngiOjExNy4zMjY3MzI2NzMyNjczMywieSI6MTgwLjA3NDI1NzQyNTc0MjU2LCJ3aWR0aCI6MTAyLjAsImhlaWdodCI6NzAuMCwicm90YXRpb24iOjAuMCwiY29sb3IiOiIjYzI0MTBjIiwib3BhY2l0eSI6MC44NSwiekluZGV4IjoxLCJpc0JhY2tncm91bmQiOmZhbHNlLCJ0ZXh0Qm94IjpudWxsLCJpbWFnZUFzc2V0SWQiOm51bGwsImltYWdlVGludCI6ZmFsc2UsInByZWZhYklkIjpudWxsLCJwcmVmYWJWYXJpYWJsZSI6bnVsbH1dLCJtZXRhIjp7InNvdXJjZVR5cGUiOiJlZGl0b3IiLCJzb3VyY2VOYW1lIjoiIiwid2FybmluZ3MiOltdfSwibGlicmFyeSI6eyJhY3RpdmVDYXRlZ29yeSI6IuWfuuehgOW9oueKtiIsImNhdGVnb3JpZXMiOlt7ImtleSI6ImZ1bmN0aW9uLWljb24tbW9ubyIsImxhYmVsIjoi5Yqf6IO95Zu+5qCHLeWNleiJsiIsInN1cHBvcnRlZCI6ZmFsc2V9LHsia2V5IjoiZnVuY3Rpb24taWNvbi1jb2xvciIsImxhYmVsIjoi5Yqf6IO95Zu+5qCHLeW9qeiJsiIsInN1cHBvcnRlZCI6ZmFsc2V9LHsia2V5IjoiZ2FtZXBsYXktaWNvbi1tb25vIiwibGFiZWwiOiLnjqnms5Xlm77moIct5Y2V6ImyIiwic3VwcG9ydGVkIjpmYWxzZX0seyJrZXkiOiJnYW1lcGxheS1pY29uLWNvbG9yIiwibGFiZWwiOiLnjqnms5Xlm77moIct5b2p6ImyIiwic3VwcG9ydGVkIjpmYWxzZX0seyJrZXkiOiJvcm5hbWVudC1tb25vIiwibGFiZWwiOiLoo4XppbDlm77moYgt5Y2V6ImyIiwic3VwcG9ydGVkIjpmYWxzZX0seyJrZXkiOiJvcm5hbWVudC1jb2xvciIsImxhYmVsIjoi6KOF6aWw5Zu+5qGILeW9qeiJsiIsInN1cHBvcnRlZCI6ZmFsc2V9LHsia2V5IjoiZmxvb3ItbW9ubyIsImxhYmVsIjoi5Zyw5p2/LeWNleiJsiIsInN1cHBvcnRlZCI6ZmFsc2V9LHsia2V5IjoiZmxvb3ItY29sb3IiLCJsYWJlbCI6IuWcsOadvy3lvanoibIiLCJzdXBwb3J0ZWQiOmZhbHNlfSx7ImtleSI6ImJhc2ljLXNoYXBlIiwibGFiZWwiOiLln7rnoYDlvaLnirYiLCJzdXBwb3J0ZWQiOnRydWV9LHsia2V5IjoiZGl2aWRlciIsImxhYmVsIjoi5YiG5Ymy57q/Iiwic3VwcG9ydGVkIjpmYWxzZX0seyJrZXkiOiJza2lsbC10YWxlbnQiLCJsYWJlbCI6IuaKgOiDveWkqei1iyIsInN1cHBvcnRlZCI6ZmFsc2V9LHsia2V5Ijoic3BlY2lhbC1jaGFyYWN0ZXIiLCJsYWJlbCI6IueJueauiuWtl+espiIsInN1cHBvcnRlZCI6ZmFsc2V9LHsia2V5IjoiaXRlbSIsImxhYmVsIjoi6YGT5YW3Iiwic3VwcG9ydGVkIjpmYWxzZX0seyJrZXkiOiJjcmVhdGlvbiIsImxhYmVsIjoi6YCg54mpIiwic3VwcG9ydGVkIjpmYWxzZX1dLCJiYXNlU2hhcGVQcmVzZXRzIjpbeyJ0eXBlIjoiZWxsaXBzZSIsImNvbG9yIjoiIzBmNzY2ZSIsIndpZHRoIjo4OC4wLCJoZWlnaHQiOjg4LjB9LHsidHlwZSI6InJlY3RhbmdsZSIsImNvbG9yIjoiI2MyNDEwYyIsIndpZHRoIjoxMDIuMCwiaGVpZ2h0Ijo3MC4wfSx7InR5cGUiOiJ0cmlhbmdsZSIsImNvbG9yIjoiIzdjM2FlZCIsIndpZHRoIjo5Ni4wLCJoZWlnaHQiOjg2LjB9LHsidHlwZSI6ImZvdXJfcG9pbnRfc3RhciIsImNvbG9yIjoiIzBmNGM4MSIsIndpZHRoIjo5MC4wLCJoZWlnaHQiOjkwLjB9LHsidHlwZSI6ImZpdmVfcG9pbnRfc3RhciIsImNvbG9yIjoiI2JlMTIzYyIsIndpZHRoIjo5Mi4wLCJoZWlnaHQiOjkyLjB9LHsidHlwZSI6InJpbmciLCJjb2xvciI6IiNmNTllMGIiLCJ3aWR0aCI6OTIuMCwiaGVpZ2h0Ijo5Mi4wfSx7InR5cGUiOiJ0ZXh0Ym94IiwiY29sb3IiOiIjZmZmZmZmIiwid2lkdGgiOjE4MC4wLCJoZWlnaHQiOjQwLjB9XSwic2F2ZWRJdGVtcyI6W3siaWQiOiJiNmE3NjI2Zi1iNjg0LTRiMjYtOWU3Yy1iNTkyMDU3NDcwODQtc2F2ZWQtMCIsIm5hbWUiOiJMMS1zY2VuZS5lZGl0b3It55+p5b2iIiwiY2F0ZWdvcnkiOiJiYXNpYy1zaGFwZSIsImVsZW1lbnQiOnsiaWQiOiJiNmE3NjI2Zi1iNjg0LTRiMjYtOWU3Yy1iNTkyMDU3NDcwODQiLCJuYW1lIjoi55+p5b2iIiwidHlwZSI6InJlY3RhbmdsZSIsIngiOjE0Ny4wMjk3MDI5NzAyOTcwMiwieSI6MTE4LjgxMTg4MTE4ODExODgyLCJ3aWR0aCI6MTAyLjAsImhlaWdodCI6NzAuMCwicm90YXRpb24iOjAuMCwiY29sb3IiOiIjYzI0MTBjIiwib3BhY2l0eSI6MC44NSwiekluZGV4IjowLCJpc0JhY2tncm91bmQiOmZhbHNlLCJ0ZXh0Qm94IjpudWxsLCJpbWFnZUFzc2V0SWQiOm51bGwsImltYWdlVGludCI6ZmFsc2UsInByZWZhYklkIjpudWxsLCJwcmVmYWJWYXJpYWJsZSI6bnVsbH19LHsiaWQiOiIwZWY5ZjA2MC03NDU1LTQ4MzMtOTNmNy03MWQ4ZDRlODgzNWEtc2F2ZWQtMSIsIm5hbWUiOiJMMi1zY2VuZS5lZGl0b3It55+p5b2iIiwiY2F0ZWdvcnkiOiJiYXNpYy1zaGFwZSIsImVsZW1lbnQiOnsiaWQiOiIwZWY5ZjA2MC03NDU1LTQ4MzMtOTNmNy03MWQ4ZDRlODgzNWEiLCJuYW1lIjoi55+p5b2iIiwidHlwZSI6InJlY3RhbmdsZSIsIngiOjExNy4zMjY3MzI2NzMyNjczMywieSI6MTgwLjA3NDI1NzQyNTc0MjU2LCJ3aWR0aCI6MTAyLjAsImhlaWdodCI6NzAuMCwicm90YXRpb24iOjAuMCwiY29sb3IiOiIjYzI0MTBjIiwib3BhY2l0eSI6MC44NSwiekluZGV4IjoxLCJpc0JhY2tncm91bmQiOmZhbHNlLCJ0ZXh0Qm94IjpudWxsLCJpbWFnZUFzc2V0SWQiOm51bGwsImltYWdlVGludCI6ZmFsc2UsInByZWZhYklkIjpudWxsLCJwcmVmYWJWYXJpYWJsZSI6bnVsbH19XX19fQ==
